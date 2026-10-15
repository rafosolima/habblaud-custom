// Interpretação dos arquivos de execução do Cursor CLI (`cursor-agent -p --output-format stream-json`), gravados pelo
// wrapper mod/habblaud-cursor/run.mjs em <HABBLAUD_CURSOR_DIR>/sessions/<execução>.jsonl:
//
// - 1ª linha `{"type":"habblaud_meta","v":1,pid,wrapperPid,parentSessionId,parentPid,name,role,cwd,startedAt}` (do
//   wrapper: quem chamou, nome e papel);
// - as linhas do stream-json do Cursor, como vieram (o wrapper só junta os pedaços de texto/raciocínio e tira o
//   `env` e o conteúdo inteiro dos arquivos): `system/init` (session_id, modelo, cwd), `user`, `thinking`
//   (delta/completed), `assistant`, `tool_call` (started/completed, a ferramenta numa chave `<nome>ToolCall` com
//   `args` e, no fim, `result.success`/`result.<erro>`), `result` (fim do pedido, com `usage`) e outros (ignorados);
// - última linha `{"type":"habblaud_end","exitCode",at}` (do wrapper, quando o cursor-agent sai).
//
// Cada linha atualiza um CursorState e pode gerar atividades e sinais. Linhas inválidas ou desconhecidas são ignoradas.
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { AgentStats, TaskItem, TaskStatus } from '../../../shared/types';
import type { ParsedActivity } from '../transcript';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

export function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** O que o wrapper conta sobre a execução (1ª linha). */
export interface CursorMeta {
  pid?: number;
  wrapperPid?: number;
  /** Sessão do Claude Code que chamou o wrapper (CLAUDE_CODE_SESSION_ID). */
  parentSessionId?: string;
  /** Processo do Claude Code que chamou (CLAUDE_PID). */
  parentPid?: number;
  name?: string;
  role?: string;
  cwd?: string;
  startedAt?: number;
  /** Conversa do Cursor retomada (`--resume <chatId>`): a execução é a mesma pessoa. */
  resume?: string;
}

export function parseMeta(o: Rec): CursorMeta {
  const m: CursorMeta = {};
  const pid = num(o.pid);
  if (pid && pid > 0) m.pid = pid;
  const wpid = num(o.wrapperPid);
  if (wpid && wpid > 0) m.wrapperPid = wpid;
  const ps = str(o.parentSessionId);
  if (ps && ps.length <= 200) m.parentSessionId = ps.trim();
  const ppid = num(o.parentPid);
  if (ppid && ppid > 0) m.parentPid = ppid;
  const name = str(o.name);
  if (name) m.name = name.trim().slice(0, 24);
  const role = str(o.role);
  if (role) m.role = role.trim().slice(0, 32);
  const cwd = str(o.cwd);
  if (cwd) m.cwd = cwd;
  const resume = str(o.resume);
  if (resume && resume.length <= 200) m.resume = resume.trim();
  const at = typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN;
  if (Number.isFinite(at)) m.startedAt = at;
  return m;
}

// ------------------------------------------------------------------ ferramentas

/** A chamada dentro de `tool_call`: a chave `<nome>ToolCall` (ou `pi…ToolCall`), os argumentos e o resultado. */
export function toolOf(toolCall: unknown): { key: string; args: Rec; result?: Rec } | undefined {
  const tc = rec(toolCall);
  if (!tc) return undefined;
  for (const [key, v] of Object.entries(tc)) {
    const body = rec(v);
    if (!body || !/ToolCall$/.test(key)) continue;
    return { key, args: rec(body.args) ?? {}, result: rec(body.result) };
  }
  return undefined;
}

const TODO_STATUS: Array<[RegExp, TaskStatus | null]> = [
  [/IN_PROGRESS/i, 'in_progress'],
  [/COMPLETED/i, 'completed'],
  [/CANCEL/i, null],
  [/PENDING/i, 'pending'],
];

/** Status de um TodoItem do Cursor (enum como texto ou número); null = cancelado (sai da lista). */
function todoStatus(v: unknown): TaskStatus | null {
  if (typeof v === 'number') return v === 2 ? 'in_progress' : v === 3 ? 'completed' : v === 4 ? null : 'pending';
  if (typeof v === 'string') for (const [re, s] of TODO_STATUS) if (re.test(v)) return s;
  return 'pending';
}

/** Tarefas de um updateTodos/createPlan, aplicadas sobre as atuais (`merge` = atualiza por id). */
export function applyTodos(current: TaskItem[], args: Rec): TaskItem[] | undefined {
  if (!Array.isArray(args.todos)) return undefined;
  const next = args.merge === true ? current.map((t) => ({ ...t })) : [];
  args.todos.forEach((raw, i) => {
    const t = rec(raw);
    if (!t) return;
    const id = str(t.id) ?? String(i + 1);
    const status = todoStatus(t.status);
    const at = next.findIndex((x) => x.id === id);
    if (status === null) {
      if (at >= 0) next.splice(at, 1);
      return;
    }
    const content = str(t.content);
    if (at >= 0) {
      next[at].status = status;
      if (content) next[at].title = truncate(maskSecrets(content.slice(0, 480)), 120);
    } else if (content) next.push({ id, title: truncate(maskSecrets(content.slice(0, 480)), 120), status });
  });
  return next.slice(0, 100);
}

/** Nome da ferramenta sem o sufixo ("readToolCall" → "read", "piBashToolCall" → "Bash"). */
function bareName(key: string): string {
  return key.replace(/ToolCall$/, '').replace(/^pi(?=[A-Z])/, '');
}

/**
 * Atividade de uma chamada de ferramenta do Cursor pelo nome da chave (`shellToolCall`, `readToolCall`...). `tool`
 * volta no nome que o resto do Habblaud usa (Bash, Read, Edit, Write, Glob, Grep, LS, TodoWrite, WebSearch, WebFetch,
 * Agent, mcp__<servidor>__<ferramenta>); desconhecida = genérica, com o nome sem o sufixo.
 */
export function describeCursorTool(key: string, args: Rec): { desc: ActivityDescription; tool: string } {
  const name = bareName(key);
  const path = str(args.path) ?? str(args.filePath) ?? str(args.targetFile);
  switch (name.toLowerCase()) {
    case 'shell':
    case 'bash':
      return { desc: describeTool('Bash', { command: str(args.command), description: str(args.description) }), tool: 'Bash' };
    case 'writeshellstdin':
      return { desc: { kind: 'run', icon: '⌨️', text: tr('Interagindo com um comando') }, tool: 'Bash' };
    case 'read':
      return { desc: describeTool('Read', { file_path: path }), tool: 'Read' };
    case 'edit':
    case 'applyagentdiff':
      return { desc: describeTool('Edit', { file_path: path }), tool: 'Edit' };
    case 'write':
      return { desc: describeTool('Write', { file_path: path }), tool: 'Write' };
    case 'delete':
      return { desc: { kind: 'edit', icon: '🗑️', text: path ? tr('Apagando {0}', [truncate(path.split(/[\\/]/).pop() ?? path, 30)]) : tr('Apagando um arquivo'), ...(path ? { detail: path } : {}) }, tool: 'Delete' };
    case 'glob':
    case 'find':
      return { desc: describeTool('Glob', { pattern: str(args.globPattern) ?? str(args.pattern) }), tool: 'Glob' };
    case 'grep':
      return { desc: describeTool('Grep', { pattern: str(args.pattern) }), tool: 'Grep' };
    case 'semsearch':
      return { desc: describeTool('Grep', { pattern: str(args.query) }), tool: 'Grep' };
    case 'ls':
      return { desc: describeTool('LS', { path }), tool: 'LS' };
    case 'updatetodos':
    case 'todo':
    case 'createplan':
      return { desc: describeTool('TodoWrite', { todos: Array.isArray(args.todos) ? args.todos.map((t) => ({ status: todoStatus(rec(t)?.status) ?? 'completed' })) : [] }), tool: 'TodoWrite' };
    case 'readtodos':
      return { desc: describeTool('TaskList', {}), tool: 'TaskList' };
    case 'mcp': {
      const server = str(args.providerIdentifier) ?? str(args.serverIdentifier) ?? 'mcp';
      const tool = str(args.toolName) ?? str(args.name) ?? 'tool';
      const full = `mcp__${server}__${tool}`;
      return { desc: describeTool(full, rec(args.args) ?? {}), tool: full };
    }
    case 'getmcptools':
    case 'listmcpresources':
    case 'readmcpresource':
      return { desc: describeTool('ListMcpResourcesTool', {}), tool: 'ListMcpResourcesTool' };
    case 'websearch':
      return { desc: describeTool('WebSearch', { query: str(args.searchTerm) ?? str(args.query) }), tool: 'WebSearch' };
    case 'webfetch':
    case 'fetch':
      return { desc: describeTool('WebFetch', { url: str(args.url) }), tool: 'WebFetch' };
    case 'task':
      return { desc: describeTool('Agent', { description: str(args.description), subagent_type: str(args.subagentType) }), tool: 'Agent' };
    case 'askquestion':
      return { desc: describeTool('AskUserQuestion', {}), tool: 'AskUserQuestion' };
    case 'readlints':
      return { desc: { kind: 'read', icon: '🧹', text: tr('Conferindo os avisos do código') }, tool: 'ReadLints' };
    default:
      return { desc: describeTool(name || 'ferramenta', args), tool: name || 'ferramenta' };
  }
}

/** Resultado com erro: a chave do resultado (ou o código de saída do shell). `rejected` = recusado. */
export function resultError(result: Rec | undefined): { error: boolean; rejected: boolean; detail?: string } {
  if (!result) return { error: false, rejected: false };
  const [kind, body] = Object.entries(result)[0] ?? [];
  if (!kind) return { error: false, rejected: false };
  if (kind === 'success' || kind === 'approved') {
    const exit = num(rec(body)?.exitCode);
    return exit ? { error: true, rejected: false, detail: tr('Código de saída {0}', [exit]) } : { error: false, rejected: false };
  }
  const b = rec(body);
  const detail = str(b?.error) ?? str(b?.message) ?? str(b?.stderr) ?? str(b?.reason);
  return { error: true, rejected: kind === 'rejected' || kind === 'permissionDenied', ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, 1_200)), 300) } : {}) };
}

// ------------------------------------------------------------------ estado

export interface CursorState {
  meta?: CursorMeta;
  sessionId?: string;
  model?: string;
  /** cwd do system/init (o do meta vale antes). */
  cwd?: string;
  /** Primeiro pedido, mascarado e cortado. */
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  /** Já viu o init ou o pedido (o agente entra no escritório). */
  started: boolean;
  /** Linha `result` vista (o pedido acabou). */
  resulted: boolean;
  resultError?: boolean;
  /** Linha `habblaud_end` vista (o cursor-agent saiu). */
  ended?: { exitCode?: number; at: number };
  firstAt?: number;
  lastAt?: number;
  /** Chamadas em andamento (call_id → tool). */
  pending: Map<string, string>;
  /** Última linha que gerou texto ou raciocínio (pedaços seguidos viram uma atividade só). */
  streaming?: 'assistant' | 'thinking';
  seq: number;
}

export function createCursorState(): CursorState {
  return { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, started: false, resulted: false, pending: new Map(), seq: 0 };
}

export type CursorSignal = { type: 'meta' } | { type: 'start' } | { type: 'result'; error: boolean } | { type: 'end' };

export interface CursorLineResult {
  at: number;
  activities: ParsedActivity[];
  signals: CursorSignal[];
}

export interface CursorParseContext {
  /** Prefixo dos ids das atividades (o id do agente). */
  idPrefix: string;
  now: number;
}

function promptOf(o: Rec): string | undefined {
  const content = rec(o.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (rec(c)?.type === 'text' ? str(rec(c)?.text) : undefined))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

export function parseCursorLine(s: CursorState, raw: string, ctx: CursorParseContext): CursorLineResult {
  const out: CursorLineResult = { at: ctx.now, activities: [], signals: [] };
  let o: Rec | undefined;
  try {
    o = rec(JSON.parse(raw));
  } catch {
    return out;
  }
  if (!o) return out;
  const ts = num(o.timestamp_ms);
  const at = ts ?? (typeof o.at === 'string' && Number.isFinite(Date.parse(o.at)) ? Date.parse(o.at) : (s.lastAt ?? s.meta?.startedAt ?? ctx.now));
  out.at = at;
  const touch = () => {
    s.firstAt ??= at;
    if (s.lastAt === undefined || at > s.lastAt) s.lastAt = at;
  };
  const push = (desc: ActivityDescription, key: string, extra: { tool?: string; error?: boolean; current?: boolean } = {}) => {
    const activity = { id: `${ctx.idPrefix}#${key}`, at, ...desc, ...(extra.tool ? { tool: extra.tool } : {}), ...(extra.error ? { error: true } : {}) };
    out.activities.push({ activity, current: extra.current ?? true });
  };
  const type = str(o.type);
  if (type !== 'assistant' && type !== 'thinking') delete s.streaming;
  const sid = str(o.session_id);
  if (sid && !s.sessionId) s.sessionId = sid;

  switch (type) {
    case 'habblaud_meta':
      s.meta = parseMeta(o);
      if (s.meta.startedAt !== undefined) out.at = s.meta.startedAt;
      out.signals.push({ type: 'meta' });
      return out;
    case 'habblaud_end': {
      const exitCode = num(o.exitCode);
      s.ended = { at, ...(exitCode !== undefined ? { exitCode } : {}) };
      touch();
      out.signals.push({ type: 'end' });
      if (!s.resulted && exitCode) push(SPECIAL.error(undefined, tr('Código de saída {0}', [exitCode])), `end`, { tool: 'Cursor', error: true });
      return out;
    }
    case 'system': {
      if (o.subtype !== 'init') return out;
      const model = str(o.model);
      if (model) s.model = model;
      const cwd = str(o.cwd);
      if (cwd) s.cwd = cwd;
      touch();
      if (!s.started) {
        s.started = true;
        out.signals.push({ type: 'start' });
      }
      return out;
    }
    case 'user': {
      const text = promptOf(o);
      touch();
      if (!s.started) {
        s.started = true;
        out.signals.push({ type: 'start' });
      }
      if (!text) return out;
      const clean = maskSecrets(text.slice(0, 2_000));
      s.title ??= truncate(clean, 120);
      push(describePrompt(clean), `user:${++s.seq}`);
      return out;
    }
    case 'thinking':
      touch();
      if (s.streaming === 'thinking' || o.subtype === 'completed') return out;
      s.streaming = 'thinking';
      push(SPECIAL.think(), `think:${++s.seq}`);
      return out;
    case 'assistant': {
      touch();
      if (s.streaming === 'assistant') return out;
      s.streaming = 'assistant';
      const text = promptOf(o);
      push(SPECIAL.respond(text ? truncate(maskSecrets(text.slice(0, 1_200)), 300) : undefined), `say:${++s.seq}`);
      return out;
    }
    case 'tool_call': {
      touch();
      const callId = str(o.call_id) ?? `call${++s.seq}`;
      const t = toolOf(o.tool_call);
      if (!t) return out;
      const { desc, tool } = describeCursorTool(t.key, t.args);
      if (o.subtype === 'started') {
        if (s.pending.has(callId)) return out;
        s.pending.set(callId, tool);
        s.stats.toolCalls++;
        if (tool === 'Agent') s.stats.subagents++;
        push(desc, callId, { tool });
        const todos = /todos|plan/i.test(t.key) ? applyTodos(s.tasks, t.args) : undefined;
        if (todos) s.tasks = todos;
        return out;
      }
      if (o.subtype !== 'completed') return out;
      const wasPending = s.pending.delete(callId);
      if (!wasPending) {
        // Começo não visto (janela do fim do arquivo): conta e mostra agora.
        s.stats.toolCalls++;
        push(desc, callId, { tool, current: false });
      }
      const ok = rec(t.result?.success);
      if (ok && /edit|write/i.test(t.key)) {
        const added = num(ok.linesAdded);
        const removed = num(ok.linesRemoved);
        if (added !== undefined) s.stats.linesAdded = (s.stats.linesAdded ?? 0) + added;
        if (removed !== undefined) s.stats.linesRemoved = (s.stats.linesRemoved ?? 0) + removed;
      }
      const err = resultError(t.result);
      if (err.rejected) push(SPECIAL.rejected(tool), `${callId}:r`, { tool });
      else if (err.error) push(SPECIAL.error(tool, err.detail), `${callId}:e`, { tool, error: true });
      return out;
    }
    case 'result': {
      touch();
      s.resulted = true;
      s.pending.clear();
      const isError = o.is_error === true || (str(o.subtype) !== undefined && o.subtype !== 'success');
      s.resultError = isError;
      const usage = rec(o.usage);
      if (usage) {
        const input = num(usage.inputTokens) ?? 0;
        const cacheRead = num(usage.cacheReadTokens) ?? 0;
        const cacheWrite = num(usage.cacheWriteTokens) ?? 0;
        s.stats.tokensIn += input + cacheRead + cacheWrite;
        s.stats.tokensOut += num(usage.outputTokens) ?? 0;
      }
      const ms = num(o.duration_ms);
      if (isError) push(SPECIAL.error('Cursor', str(o.result) ? truncate(maskSecrets(String(o.result).slice(0, 1_200)), 300) : undefined), `result`, { tool: 'Cursor', error: true });
      else push(SPECIAL.turnDone(ms), `result`);
      out.signals.push({ type: 'result', error: isError });
      return out;
    }
    default:
      return out;
  }
}
