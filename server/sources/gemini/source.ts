// Fonte de agentes do Gemini CLI (AgentSource 'gemini'): sessões em GEMINI_HOME/tmp/<hash>/chats/session-*.jsonl.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectGeminiAccounts } from './accounts';
import { isGeminiPresent, isGeminiWorking, listGeminiSessions, type GeminiSessionRef } from './files';
import { createGeminiState, parseGeminiLine, type GeminiLineResult, type GeminiState } from './session';
import { createGeminiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

const CLOSE_AFTER_MISSING_MS = 1_500;
const BACKLOG_MAX = 400;
const MAIN_ROLE = tr('Agente principal (Gemini)');

export interface GeminiSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas GEMINI_HOME observadas. */
  homes: string[];
  home?: string;
  now?: () => number;
  pollMs?: number;
  watch?: boolean;
}

interface SessionTracker {
  agentId: string;
  sessionId: string;
  accountId: string;
  home: string;
  ref: GeminiSessionRef;
  path: string;
  tail: FileTail;
  state: GeminiState;
  inOffice: boolean;
  left: boolean;
  backlog: GeminiLineResult[];
  firstSeenAt: number;
  lastWriteAt: number;
  missingSince?: number;
}

export class GeminiSource implements AgentSource {
  readonly provider = 'gemini' as const;
  private sessions = new Map<string, SessionTracker>();
  private entries: readonly AccountEntry[] = [];
  private homeByAccount = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private watcher?: FSWatcher;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly opts: GeminiSourceOptions) {
    this.now = opts.now ?? Date.now;
    const claude = opts.accounts.entries();
    const detected = detectGeminiAccounts(opts.homes, {
      taken: { shorts: claude.map((e) => e.detected.short), colors: claude.map((e) => e.detected.color) },
      home: opts.home,
    });
    this.entries = opts.accounts.setProviderAccounts(
      'gemini',
      opts.homes.map((dir, i) => ({ dir, detected: detected[i] })),
    );
    for (const e of this.entries) this.homeByAccount.set(e.id, e.dir);
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
    if (this.opts.watch !== false) {
      for (const e of this.entries) {
        const tmp = join(e.dir, 'tmp');
        try {
          this.watcher = watch(tmp, { recursive: true }, () => this.schedulePoll());
        } catch {
          // sem tmp ainda
        }
      }
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

  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  sources(): SourceInfo[] {
    return this.entries.map((e) => {
      let sessions = 0;
      for (const t of this.sessions.values()) {
        if (t.inOffice && t.accountId === e.id) sessions++;
      }
      return { label: e.id, provider: 'gemini', path: e.dir, sessions, ok: true };
    });
  }

  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  transcriptPathOf(agentId: string): string | undefined {
    const sid = agentId.startsWith('gemini:') ? agentId.slice('gemini:'.length) : agentId;
    return this.sessions.get(sid)?.path;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    const sid = agentId.startsWith('gemini:') ? agentId.slice('gemini:'.length) : agentId;
    return this.sessions.has(sid) ? createGeminiTerminalParser() : undefined;
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    if (this.kick) return;
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, 120);
    this.kick.unref?.();
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce('gemini-poll', tr('Gemini: {0}', [errMsg(err)]));
    }
  }

  private poll(boot: boolean): void {
    const now = this.now();
    const present = new Set<string>();
    for (const entry of this.entries) {
      const home = entry.dir;
      for (const ref of listGeminiSessions(home)) {
        if (ref.kind === 'subagent') continue;
        if (!isGeminiPresent(ref.mtimeMs, now)) continue;
        const sessionId = ref.sessionId;
        const key = sessionId;
        present.add(key);
        let t = this.sessions.get(key);
        if (!t || t.path !== ref.path) {
          if (t?.inOffice) this.leave(t);
          t = {
            agentId: `gemini:${sessionId}`,
            sessionId,
            accountId: entry.id,
            home,
            ref,
            path: ref.path,
            tail: new FileTail(ref.path),
            state: createGeminiState(),
            inOffice: false,
            left: false,
            backlog: [],
            firstSeenAt: now,
            lastWriteAt: ref.mtimeMs,
          };
          this.sessions.set(key, t);
          this.read(t, false);
        } else {
          t.ref = ref;
          t.lastWriteAt = Math.max(t.lastWriteAt, ref.mtimeMs);
          this.read(t, true);
        }
        delete t.missingSince;
        if (t.state.cwd) ref.cwd = t.state.cwd;
        if (!ref.cwd && t.state.cwd) ref.cwd = t.state.cwd;
        this.sync(t, ref, now);
        if (t.left) this.sessions.delete(key);
      }
    }
    for (const [key, t] of [...this.sessions]) {
      if (present.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.sessions.delete(key);
    }
  }

  private read(t: SessionTracker, live: boolean): void {
    for (let i = 0; i < 64; i++) {
      let res;
      try {
        res = t.tail.read();
      } catch (err) {
        log.warnOnce(`gemini-read:${t.sessionId}`, tr('Gemini: sessão {0} ilegível ({1}).', [t.sessionId, errMsg(err)]));
        return;
      }
      if (res.missing) return;
      t.lastWriteAt = t.tail.mtimeMs;
      if (res.reset) t.state = createGeminiState();
      for (const line of res.lines) {
        this.apply(t, parseGeminiLine(t.state, line, { idPrefix: t.agentId, now: this.now() }), live);
      }
      if (res.lines.length) this.applySummary(t);
      if (!res.lines.length) break;
    }
  }

  private apply(t: SessionTracker, res: GeminiLineResult, live: boolean): void {
    if (res.cwd) t.ref.cwd = res.cwd;
    if (!live || !t.inOffice) {
      if (res.activities.length) {
        t.backlog.push(res);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    for (const a of res.activities) this.opts.office.addActivity(t.agentId, a.activity, a.current, { feed: true });
  }

  private sync(t: SessionTracker, ref: GeminiSessionRef, now: number): void {
    const office = this.opts.office;
    const cwd = t.state.cwd ?? ref.cwd;
    if (!cwd) return;
    const open = isGeminiPresent(t.lastWriteAt, now);
    if (!t.inOffice && !t.left) {
      if (!t.state.started) return;
      if (!open) {
        t.left = true;
        return;
      }
      office.addMain({
        id: t.agentId,
        provider: 'gemini',
        account: t.accountId,
        sessionId: t.sessionId,
        cwd,
        role: MAIN_ROLE,
        startedAt: t.state.firstAt ?? ref.mtimeMs,
        status: 'working',
      });
      if (!office.has(t.agentId)) return;
      t.inOffice = true;
      const backlog = t.backlog;
      t.backlog = [];
      for (const res of backlog) for (const a of res.activities) office.addActivity(t.agentId, a.activity, a.current, { feed: false });
      this.applySummary(t);
    }
    if (!t.inOffice) return;
    if (!open) {
      this.leave(t);
      t.left = true;
      return;
    }
    const working = isGeminiWorking(t.lastWriteAt, now) || !t.state.turnIdle;
    office.setStatus(t.agentId, working ? 'working' : 'idle');
    if (working) office.fillWorkingActivity(t.agentId);
  }

  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    this.opts.office.closeMain(t.agentId);
    t.inOffice = false;
  }

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    if (s.model) summary.model = s.model;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.agentId, summary);
  }
}
