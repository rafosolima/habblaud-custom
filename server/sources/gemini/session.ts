// Linhas do session-*.jsonl do Gemini CLI (user/gemini, toolCalls, metadata).
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate } from '../../../shared/activity';
import type { ActivityDescription } from '../../../shared/activity';
import type { ParsedActivity } from '../transcript';
import type { TaskItem } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

export interface GeminiState {
  sessionId?: string;
  projectHash?: string;
  cwd?: string;
  title?: string;
  model?: string;
  started: boolean;
  tasks: TaskItem[];
  stats: { toolCalls: number; tokensIn: number; tokensOut: number; subagents: number };
  seq: number;
  firstAt?: number;
  lastAt?: number;
  /** Última mensagem do modelo sem ferramentas pendentes. */
  turnIdle: boolean;
}

export interface GeminiLineResult {
  at: number;
  activities: ParsedActivity[];
  cwd?: string;
  sessionId?: string;
}

export interface GeminiParseContext {
  idPrefix: string;
  now: number;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const o = rec(item);
    if (!o) continue;
    const t = str(o.text);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

function applyTokens(s: GeminiState, tokens: Rec | undefined): void {
  if (!tokens) return;
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const cached = num(tokens.cached) ?? 0;
  if (input + output + cached > 0) {
    s.stats.tokensIn = input + cached;
    s.stats.tokensOut = output;
  }
}

export function createGeminiState(): GeminiState {
  return {
    started: false,
    tasks: [],
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seq: 0,
    turnIdle: false,
  };
}

export function parseGeminiLine(s: GeminiState, raw: string, ctx: GeminiParseContext): GeminiLineResult {
  const out: GeminiLineResult = { at: ctx.now, activities: [] };
  let o: Rec | undefined;
  try {
    o = rec(JSON.parse(raw));
  } catch {
    return out;
  }
  if (!o) return out;
  const at = ctx.now;
  const push = (desc: ActivityDescription, key: string, extra: { tool?: string; error?: boolean; current?: boolean } = {}) => {
    out.activities.push({
      activity: {
        id: `${ctx.idPrefix}#${key}`,
        at,
        ...desc,
        ...(extra.tool ? { tool: extra.tool } : {}),
        ...(extra.error ? { error: true } : {}),
      },
      current: extra.current ?? true,
    });
  };

  const set = rec(o.$set);
  if (set) {
    const sid = str(set.sessionId);
    if (sid) {
      s.sessionId = sid;
      out.sessionId = sid;
    }
    const ph = str(set.projectHash);
    if (ph) s.projectHash = ph;
    const dirs = set.directories;
    if (Array.isArray(dirs) && typeof dirs[0] === 'string' && dirs[0].trim()) {
      s.cwd = dirs[0].trim();
      out.cwd = s.cwd;
    }
    return out;
  }

  if (o.type === 'session_metadata' || (str(o.sessionId) && str(o.projectHash) && !o.type)) {
    s.sessionId = str(o.sessionId) ?? s.sessionId;
    s.projectHash = str(o.projectHash) ?? s.projectHash;
    out.sessionId = s.sessionId;
    const dirs = o.directories;
    if (Array.isArray(dirs) && typeof dirs[0] === 'string' && dirs[0].trim()) {
      s.cwd = dirs[0].trim();
      out.cwd = s.cwd;
    }
    return out;
  }

  if (o.type === 'message_update') {
    applyTokens(s, rec(o.tokens));
    return out;
  }

  const type = str(o.type);
  if (type === 'user') {
    s.started = true;
    s.turnIdle = false;
    s.firstAt ??= at;
    s.lastAt = at;
    const text = textOfContent(o.content);
    if (text) {
      const clean = maskSecrets(text.slice(0, 2_000));
      s.title ??= truncate(clean, 120);
      push(describePrompt(clean), `user:${++s.seq}`);
    }
    return out;
  }

  if (type === 'gemini') {
    s.started = true;
    s.firstAt ??= at;
    s.lastAt = at;
    const model = str(o.model);
    if (model) s.model = model;
    applyTokens(s, rec(o.tokens));
    const toolCalls = o.toolCalls;
    let pending = false;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const t = rec(tc);
        if (!t) continue;
        const name = str(t.name) ?? str(t.displayName) ?? 'ferramenta';
        const args = rec(t.args) ?? {};
        const status = str(t.status);
        const desc = describeTool(name, args);
        const tool = name;
        const id = str(t.id) ?? `t${++s.seq}`;
        s.stats.toolCalls++;
        const done = status === 'success' || status === 'completed' || status === 'done';
        if (!done && status !== 'error' && status !== 'failed') pending = true;
        push(desc, id, { tool, error: status === 'error' || status === 'failed', current: !done });
      }
    }
    const text = textOfContent(o.content);
    if (text?.trim() && !text.startsWith('[')) {
      push(SPECIAL.respond(truncate(maskSecrets(text.slice(0, 1_200)), 300)), `say:${++s.seq}`, { current: false });
    }
    s.turnIdle = !pending;
    return out;
  }

  if (type === 'error') {
    push(SPECIAL.error(undefined, textOfContent(o.content) || tr('Erro')), `err:${++s.seq}`, { error: true });
    s.turnIdle = true;
  }

  return out;
}
