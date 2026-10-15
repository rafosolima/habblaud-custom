// Fonte de agentes do Cursor CLI (AgentSource 'cursor', ver sources/source.ts). O Cursor não grava um registro de
// sessões que dê para observar: quem roda o `cursor-agent` pelo wrapper do Habblaud (mod/habblaud-cursor/run.mjs) deixa
// um arquivo por execução em <dir>/sessions/<execução>.jsonl (formato em stream.ts). Esta fonte lê esses arquivos
// (FileTail, polling de 1 s + fs.watch como acelerador) e alimenta o Office.
//
// - Presença: arquivo sem a linha `habblaud_end` e, fora do Docker, o processo do cursor-agent (ou do wrapper) vivo;
//   no Docker (PIDs do host), o arquivo escrito há menos de QUIET_MS. Um arquivo encerrado, ou parado há mais de
//   STALE_MS, é ignorado no boot; ao vivo, o fim faz o agente sair.
// - Entrada: só depois do `system/init` ou do pedido (`user`), ou com o arquivo com mais de ENTER_AFTER_MS (o meta
//   sozinho, logo depois de lançar, ainda não tem o título nem a sessão).
// - Ligação: o meta traz a sessão do Claude Code que chamou o wrapper (CLAUDE_CODE_SESSION_ID; senão CLAUDE_PID). Com
//   um agente principal do Claude Code aberto nessa sessão, o Cursor entra como SUBAGENTE dele (na sala dele, com
//   `provider: 'cursor'` e a conta do Cursor); sem ele, como agente principal na sala do cwd.
// - Status: trabalhando até a linha `result`; aí o principal fica ocioso ("Concluiu") e o subagente entrega. O fim
//   (`habblaud_end`, ou o processo morto) fecha o principal.
// - Nome: o `--name`/`--role` do wrapper (ou a equipe, team.json) — "Lucas (Dev - Mestre)".
// Nunca escreve nada: a limpeza dos arquivos antigos é do wrapper.
import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS, type DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { IdentityHint, Office, TranscriptSummary } from '../../model/office';
import { pidAlive } from '../registry';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { createCursorState, parseCursorLine, type CursorLineResult, type CursorState } from './stream';
import { createCursorTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Subpasta com um arquivo por execução. */
export const SESSIONS_DIR = 'sessions';
/** Arquivo modificado há mais que isto e sem fim: execução abandonada (crash do wrapper). */
export const STALE_MS = 24 * 3600_000;
/** No Docker (sem PIDs): sem nenhuma escrita há este tempo, a execução é dada como encerrada. */
export const QUIET_MS = 30 * 60_000;
/** O meta sozinho espera isto pelo init/pedido antes de entrar mesmo assim. */
export const ENTER_AFTER_MS = 4_000;
/** Execução vista pela primeira vez ao vivo já encerrada há menos disto: entra e sai (para não sumir sem ser vista). */
const RECENT_END_MS = 60_000;
const BACKLOG_MAX = 400;
const MAIN_ROLE = tr('Agente principal (Cursor)');
const SUB_ROLE = tr('Desenvolvedor (Cursor)');
/** Id da conta do Cursor (uma só: o Cursor CLI não tem pastas de conta como o Claude Code e o Codex). */
export const CURSOR_ACCOUNT = '.cursor';

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta do Habblaud para o Cursor (HABBLAUD_CURSOR_DIR ou ~/.habblaud/cursor); lida, nunca escrita. */
  dir: string;
  /** Rodando no Docker: os PIDs do meta são do host (não dá para conferir). */
  inDocker?: boolean;
  now?: () => number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  /** Desliga o fs.watch (testes). */
  watch?: boolean;
}

interface RunTracker {
  /** Nome do arquivo sem `.jsonl`. */
  run: string;
  /** Chave da execução (`cursor:<execução>`): prefixo das atividades. */
  key: string;
  /**
   * Id do agente: `cursor:<chatId>` (o session_id do Cursor, ou o `--resume` do meta). Um `--resume` da mesma conversa
   * volta no mesmo personagem; sem o chat (ou com ele já no escritório por outra execução), `cursor:<execução>`.
   */
  agentId: string;
  path: string;
  tail: FileTail;
  state: CursorState;
  kind?: 'main' | 'sub';
  parentId?: string;
  inOffice: boolean;
  /** Já saiu (principal encerrado ou subagente entregue): não volta. */
  left: boolean;
  /** Entregou (subagente) / concluiu (principal) pelo `result`. */
  delivered: boolean;
  backlog: CursorLineResult[];
  firstSeenAt: number;
  lastWriteAt: number;
}

function capitalize(s: string): string {
  return s ? `${s[0].toUpperCase()}${s.slice(1)}` : s;
}

export class CursorSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private runs = new Map<string, RunTracker>();
  /** Arquivos ignorados (encerrados ou velhos), com o mtime visto: só são relidos se mudarem. */
  private ignored = new Map<string, number>();
  private registered = false;
  private entry?: AccountEntry;
  private error?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private watcher?: FSWatcher;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private stopped = false;

  constructor(private readonly opts: CursorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? pidAlive;
  }

  get sessionsDir(): string {
    return join(this.opts.dir, SESSIONS_DIR);
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    this.watcher?.close();
    this.watcher = undefined;
  }

  sources(): SourceInfo[] {
    if (!this.entry) return [];
    let sessions = 0;
    for (const r of this.runs.values()) if (r.inOffice) sessions++;
    const info: SourceInfo = { label: this.entry.id, provider: 'cursor', path: this.opts.dir, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  /** Conta do Cursor no AccountsService (depois que a pasta existe). */
  accountEntry(): AccountEntry | undefined {
    return this.entry;
  }

  transcriptPathOf(agentId: string): string | undefined {
    return this.runOf(agentId)?.path;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.runOf(agentId) ? createCursorTerminalParser() : undefined;
  }

  /** A execução (no escritório) do agente; com mais de uma (retomadas), a mais recente. */
  private runOf(agentId: string): RunTracker | undefined {
    let found: RunTracker | undefined;
    for (const r of this.runs.values()) if (r.inOffice && r.agentId === agentId && (!found || r.firstSeenAt >= found.firstSeenAt)) found = r;
    return found;
  }

  // ---------------------------------------------------------------- conta

  /** Registra a conta do Cursor (uma vez, quando a pasta aparece), sem repetir letra e cor das outras contas. */
  private register(): void {
    if (this.registered) return;
    this.registered = true;
    const others = this.opts.accounts.allEntries();
    const shorts = new Set(others.map((e) => e.detected.short.toUpperCase()));
    const colors = new Set(others.map((e) => e.detected.color));
    const short = ['R', 'K', 'Q', 'U', 'V', 'W'].find((s) => !shorts.has(s)) ?? 'R';
    const color = ['#5ec4b6', ...ACCOUNT_COLORS].find((c) => !colors.has(c)) ?? '#5ec4b6';
    const detected: DetectedAccount = { id: CURSOR_ACCOUNT, provider: 'cursor', configDir: this.opts.dir, short, name: 'Cursor', color };
    this.entry = this.opts.accounts.setProviderAccounts('cursor', [{ dir: this.opts.dir, detected }])[0];
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`cursor-poll:${errMsg(err)}`, tr('Cursor: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, 150);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = this.now();
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir).filter((n) => n.endsWith('.jsonl'));
      delete this.error;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.error = errMsg(err);
      names = [];
    }
    if (names.length || statOk(this.opts.dir)) this.register();
    this.watchDir();
    const present = new Set<string>();
    for (const name of names) {
      const run = name.slice(0, -'.jsonl'.length);
      const key = `cursor:${run}`;
      present.add(key);
      const path = join(this.sessionsDir, name);
      let r = this.runs.get(key);
      if (!r) {
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (this.ignored.get(path) === mtime) continue;
        if (now - mtime > STALE_MS) {
          this.ignored.set(path, mtime);
          continue;
        }
        r = { run, key, agentId: key, path, tail: new FileTail(path), state: createCursorState(), inOffice: false, left: false, delivered: false, backlog: [], firstSeenAt: now, lastWriteAt: mtime };
        this.read(r, false);
        if (r.state.ended && (boot || now - r.state.ended.at > RECENT_END_MS)) {
          this.ignored.set(path, r.lastWriteAt);
          continue;
        }
        if (!r.state.ended && !this.alive(r, now)) {
          this.ignored.set(path, r.lastWriteAt);
          continue;
        }
        this.runs.set(key, r);
      } else {
        this.read(r, true);
      }
      try {
        this.sync(r, now);
      } catch (err) {
        log.warnOnce(`cursor-run:${key}:${errMsg(err)}`, tr('Cursor: execução {0}: {1}', [run, errMsg(err)]));
      }
      if (r.left) {
        this.runs.delete(key);
        this.ignored.set(path, r.lastWriteAt);
      }
    }
    // Arquivo apagado: quem estava no escritório sai.
    for (const [key, r] of [...this.runs]) {
      if (present.has(key)) continue;
      this.leave(r);
      this.runs.delete(key);
    }
  }

  /** Execução ainda rodando (sem o fim): processo vivo (fora do Docker) ou escrita recente (no Docker). */
  private alive(r: RunTracker, now: number): boolean {
    if (r.state.ended) return false;
    if (now - r.lastWriteAt > STALE_MS) return false;
    const m = r.state.meta;
    if (this.opts.inDocker || (!m?.pid && !m?.wrapperPid)) return now - r.lastWriteAt < QUIET_MS;
    return (!!m.pid && this.isAlive(m.pid)) || (!!m.wrapperPid && this.isAlive(m.wrapperPid));
  }

  /** Lê o que for novo: ao vivo vai direto ao escritório; antes de entrar, fica no backlog. */
  private read(r: RunTracker, live: boolean): void {
    for (let i = 0; i < 64; i++) {
      let res;
      try {
        res = r.tail.read();
      } catch (err) {
        log.warnOnce(`cursor-read:${r.key}`, tr('Cursor: arquivo de {0} ilegível ({1}).', [r.run, errMsg(err)]));
        return;
      }
      if (res.missing) return;
      r.lastWriteAt = r.tail.mtimeMs;
      if (res.reset) r.state = createCursorState();
      for (const line of res.lines) this.apply(r, parseCursorLine(r.state, line, { idPrefix: r.key, now: this.now() }), live);
      if (res.lines.length) this.applySummary(r);
      if (!res.more) break;
    }
  }

  private apply(r: RunTracker, res: CursorLineResult, live: boolean): void {
    if (!live || !r.inOffice) {
      if (res.activities.length) {
        r.backlog.push(res);
        if (r.backlog.length > BACKLOG_MAX) r.backlog.splice(0, r.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    for (const a of res.activities) this.opts.office.addActivity(r.agentId, a.activity, a.current, { feed: true });
  }

  /** Um ciclo de uma execução: entra, muda de status ou sai. */
  private sync(r: RunTracker, now: number): void {
    const office = this.opts.office;
    if (r.inOffice && !office.has(r.agentId)) {
      // Saiu do escritório por fora (o principal que o chamou encerrou): volta como principal se ainda roda.
      r.inOffice = false;
      delete r.kind;
    }
    const s = r.state;
    const running = this.alive(r, now);
    if (!r.inOffice && !r.left) {
      const ready = s.started || s.resulted || !!s.ended || now - (s.meta?.startedAt ?? r.firstSeenAt) >= ENTER_AFTER_MS;
      if (!ready || (!running && !s.ended)) {
        if (!running && !s.ended) r.left = true;
        return;
      }
      this.enter(r, now);
      if (!r.inOffice) return;
    }
    if (!r.inOffice) return;
    if (s.resulted && !r.delivered) {
      r.delivered = true;
      if (r.kind === 'sub') office.completeSub(r.agentId);
      else office.setStatus(r.agentId, 'idle');
    }
    if (!running) {
      this.leave(r);
      return;
    }
    if (r.kind === 'main' && !r.delivered) office.fillWorkingActivity(r.agentId);
  }

  /** Principal do Claude Code que chamou o wrapper: pela sessão (CLAUDE_CODE_SESSION_ID); senão pelo PID (CLAUDE_PID). */
  private parentOf(r: RunTracker): string | undefined {
    const m = r.state.meta;
    if (!m?.parentSessionId && !m?.parentPid) return undefined;
    const open = this.opts.office
      .list()
      .filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude' && a.status !== 'offline');
    const bySession = m.parentSessionId ? open.find((a) => a.sessionId === m.parentSessionId) : undefined;
    if (bySession) return bySession.id;
    if (m.parentPid) return open.find((a) => a.id.endsWith(`:${m.parentPid}`))?.id;
    return undefined;
  }

  private enter(r: RunTracker, now: number): void {
    const office = this.opts.office;
    const s = r.state;
    const m = s.meta ?? {};
    const account = this.entry?.id ?? CURSOR_ACCOUNT;
    const identity: IdentityHint = {};
    if (m.name) {
      identity.cursorName = m.name;
      identity.name = m.name;
    }
    if (m.role) identity.role = m.role;
    const startedAt = m.startedAt ?? s.firstAt ?? now;
    const sessionId = s.sessionId ?? m.resume ?? r.run;
    // A mesma conversa (session_id, ou o --resume) = o mesmo agente; outra execução dela ainda rodando = à parte.
    const chat = s.sessionId ?? m.resume;
    const busy = (id: string) => [...this.runs.values()].some((o) => o !== r && o.inOffice && o.agentId === id);
    r.agentId = chat && !busy(`cursor:${chat}`) ? `cursor:${chat}` : r.key;
    const parent = this.parentOf(r);
    if (parent) {
      const added = office.addSub({
        id: r.agentId,
        parentId: parent,
        sessionId,
        role: m.role ? capitalize(m.role) : SUB_ROLE,
        title: s.title,
        background: false,
        startedAt,
        provider: 'cursor',
        account,
        ...(m.name ? { identity } : {}),
      });
      if (!added) return;
      r.kind = 'sub';
      r.parentId = parent;
    } else {
      const cwd = m.cwd ?? s.cwd;
      if (!cwd) return;
      office.addMain({
        id: r.agentId,
        provider: 'cursor',
        account,
        sessionId,
        cwd,
        role: m.role ? capitalize(m.role) : MAIN_ROLE,
        startedAt,
        status: 'working',
        ...(m.name ? { identity } : {}),
      });
      if (!office.has(r.agentId)) return;
      r.kind = 'main';
    }
    r.inOffice = true;
    const backlog = r.backlog;
    r.backlog = [];
    for (const res of backlog) for (const a of res.activities) office.addActivity(r.agentId, a.activity, a.current, { feed: false });
    this.applySummary(r);
  }

  /** Sai: o principal encerra; o subagente entrega (se ainda não tinha entregado). */
  private leave(r: RunTracker): void {
    r.left = true;
    if (!r.inOffice) return;
    const office = this.opts.office;
    if (r.kind === 'sub') office.completeSub(r.agentId, { notify: !r.delivered });
    else office.closeMain(r.agentId);
    r.inOffice = false;
  }

  private applySummary(r: RunTracker): void {
    if (!r.inOffice) return;
    const s = r.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    if (s.model) summary.model = s.model;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(r.agentId, summary);
  }

  private watchDir(): void {
    if (this.opts.watch === false || this.watcher || this.stopped) return;
    try {
      const w = watch(this.sessionsDir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        if (this.watcher === w) this.watcher = undefined;
      });
      this.watcher = w;
    } catch {
      // pasta ainda não existe ou sem suporte: o polling cobre
    }
  }
}

function statOk(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
