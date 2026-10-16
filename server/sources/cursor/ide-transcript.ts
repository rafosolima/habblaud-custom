// Transcripts do Cursor IDE (~/.cursor/projects/<slug>/agent-transcripts/<chatId>.jsonl): formato role/message,
// compatível com as atividades e o terminal do stream-json do cursor-agent (stream.ts).
import { describePrompt, maskSecrets, SPECIAL, truncate } from '../../../shared/activity';
import type { ActivityDescription } from '../../../shared/activity';
import { describeTool } from '../../../shared/activity';
import type { ParsedActivity } from '../transcript';
import { createCursorState, rec, str, type CursorLineResult, type CursorParseContext, type CursorState } from './stream';

type Rec = Record<string, unknown>;

function userText(o: Rec): string | undefined {
  const content = rec(o.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return (
    content
      .map((c) => (rec(c)?.type === 'text' ? str(rec(c)?.text) : undefined))
      .filter(Boolean)
      .join('\n') || undefined
  );
}

/** Título legível a partir do pedido do usuário (tira tags do Cursor). */
export function titleFromUserPrompt(text: string): string {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
  const raw = (q?.[1] ?? text).trim();
  return truncate(maskSecrets(raw.slice(0, 2_000)), 120);
}

function toolDesc(name: string, input: Rec): { desc: ActivityDescription; tool: string } {
  const tool = name.trim() || 'ferramenta';
  return { desc: describeTool(tool, input), tool };
}

/** Tipo do subagente (renato-techlead, julia-qa, explore…) quando o Cursor lança Task/Agent. */
export function subagentTypeFromTool(name: string, input: Rec): string | undefined {
  const n = name.trim().toLowerCase();
  const pick = (o: Rec) => str(o.subagent_type) ?? str(o.subagentType);
  if (n === 'task' || n === 'agent') return pick(input);
  if (n === 'callgenerictool' || n === 'calldynamictool') {
    const tool = (str(input.toolName) ?? str(input.tool_name) ?? '').toLowerCase();
    if (tool !== 'task') return undefined;
    const args = rec(input.arguments) ?? input;
    return pick(args);
  }
  return undefined;
}

export function parseIdeTranscriptLine(s: CursorState, raw: string, ctx: CursorParseContext): CursorLineResult {
  const out: CursorLineResult = { at: ctx.now, activities: [], signals: [] };
  let o: Rec | undefined;
  try {
    o = rec(JSON.parse(raw));
  } catch {
    return out;
  }
  if (!o) return out;
  const at = ctx.now;
  out.at = at;
  const touch = () => {
    s.firstAt ??= at;
    if (s.lastAt === undefined || at > s.lastAt) s.lastAt = at;
  };
  const push = (desc: ActivityDescription, key: string, extra: { tool?: string; error?: boolean; current?: boolean } = {}) => {
    out.activities.push({
      activity: { id: `${ctx.idPrefix}#${key}`, at, ...desc, ...(extra.tool ? { tool: extra.tool } : {}), ...(extra.error ? { error: true } : {}) },
      current: extra.current ?? true,
    });
  };

  const type = str(o.type);
  const role = str(o.role);

  if (type === 'turn_ended') {
    touch();
    const ok = str(o.status) === 'success';
    s.resulted = true;
    s.resultError = !ok;
    out.signals.push({ type: 'result', error: !ok });
    if (!ok) push(SPECIAL.error(undefined, str(o.status) ?? 'erro'), `turn:${++s.seq}`, { tool: 'Cursor', error: true });
    return out;
  }

  if (role === 'user' || type === 'user') {
    const text = userText(o);
    touch();
    if (!s.started) {
      s.started = true;
      out.signals.push({ type: 'start' });
    }
    if (!text) return out;
    const clean = maskSecrets(text.slice(0, 2_000));
    s.title ??= titleFromUserPrompt(clean);
    push(describePrompt(clean), `user:${++s.seq}`);
    return out;
  }

  if (role === 'assistant' || type === 'assistant') {
    touch();
    if (!s.started) {
      s.started = true;
      out.signals.push({ type: 'start' });
    }
    const content = rec(o.message)?.content;
    if (!Array.isArray(content)) return out;
    let said = false;
    for (const item of content) {
      const c = rec(item);
      if (!c) continue;
      if (c.type === 'text') {
        const text = str(c.text);
        if (text && !said && text.trim() && !text.startsWith('[')) {
          said = true;
          push(SPECIAL.respond(truncate(maskSecrets(text.slice(0, 1_200)), 300)), `say:${++s.seq}`);
        }
        continue;
      }
      if (c.type === 'tool_use') {
        const name = str(c.name) ?? 'ferramenta';
        const input = rec(c.input) ?? {};
        const spawnType = subagentTypeFromTool(name, input);
        if (spawnType) {
          s.pendingSpawns ??= [];
          s.pendingSpawns.push(spawnType);
        }
        const { desc, tool } = toolDesc(name, input);
        const id = str(c.id) ?? `t${++s.seq}`;
        s.stats.toolCalls++;
        if (tool === 'Agent' || tool === 'Task') s.stats.subagents++;
        push(desc, id, { tool });
      }
    }
    return out;
  }

  return out;
}
