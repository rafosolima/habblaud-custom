// Terminal do Cursor: converte as linhas do arquivo de execução (ver stream.ts) em TerminalEntry — o pedido, o
// raciocínio (resumido), as ferramentas com o resultado, o texto da resposta e o fim —, com segredos mascarados e textos
// truncados pelas mesmas regras do terminal do Claude Code (sources/terminal.ts).
import type { TerminalEntry } from '../../../shared/types';
import { formatDuration } from '../../../shared/activity';
import { marked, oneLine, prepare, INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { describeCursorTool, rec, resultError, str, toolOf } from './stream';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function textOf(o: Rec): string {
  const content = rec(o.message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (rec(c)?.type === 'text' ? (str(rec(c)?.text) ?? '') : '')).join('');
}

/** Argumentos no formato do Claude Code, para o título e a entrada (toolView). */
function viewInput(tool: string, args: Rec): Rec {
  const path = str(args.path);
  switch (tool) {
    case 'Bash':
      return { command: str(args.command) ?? '' };
    case 'Read':
    case 'Write':
    case 'Edit':
      return { file_path: path ?? '' };
    case 'LS':
      return { path: path ?? '' };
    case 'Glob':
      return { pattern: str(args.globPattern) ?? str(args.pattern) ?? '' };
    case 'Grep':
      return { pattern: str(args.pattern) ?? str(args.query) ?? '' };
    case 'WebSearch':
      return { query: str(args.searchTerm) ?? '' };
    default:
      return tool.startsWith('mcp__') ? (rec(args.args) ?? {}) : args;
  }
}

/** Texto do resultado de uma ferramenta (stdout/stderr do shell, conteúdo, mensagem de erro). */
function resultText(result: Rec | undefined): string {
  if (!result) return '';
  const body = rec(Object.values(result)[0]);
  if (!body) return '';
  const parts = [str(body.interleavedOutput) ?? [str(body.stdout), str(body.stderr)].filter(Boolean).join('\n')];
  if (!parts[0]) parts[0] = str(body.content) ?? str(body.error) ?? str(body.message) ?? str(body.diffString) ?? '';
  return parts.join('\n');
}

class CursorTerminalParser implements TerminalParser {
  private readonly seen = new Set<string>();
  private seq = 0;
  private lastAt = 0;

  push(line: string): TerminalEntry[] {
    let o: Rec | undefined;
    try {
      o = rec(JSON.parse(line));
    } catch {
      return [];
    }
    if (!o) return [];
    const ts = typeof o.timestamp_ms === 'number' ? o.timestamp_ms : typeof o.at === 'string' ? Date.parse(o.at) : typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN;
    const at = Number.isFinite(ts) ? ts : this.lastAt;
    this.lastAt = at;
    const id = (k: string) => `cursor:${k}`;
    const out: TerminalEntry[] = [];
    const role = str(o.role);
    if (role === 'user' && !str(o.type)) {
      const text = textOf(o);
      if (text) out.push({ kind: 'user', id: id(`user:${++this.seq}`), at, text: marked(prepare(text, TEXT_MAX)) });
      return out.filter((e) => {
        if (this.seen.has(e.id)) return false;
        this.seen.add(e.id);
        return true;
      });
    }
    if (role === 'assistant' && !str(o.type)) {
      const content = rec(o.message)?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const c = rec(item);
          if (!c) continue;
          if (c.type === 'text') {
            const text = str(c.text);
            if (text?.trim()) out.push({ kind: 'assistant', id: id(`say:${++this.seq}`), at, text: marked(prepare(text, TEXT_MAX)) });
          } else if (c.type === 'tool_use') {
            const name = str(c.name) ?? 'ferramenta';
            const input = rec(c.input) ?? {};
            const callId = str(c.id) ?? `call${++this.seq}`;
            if (!this.seen.has(`tool:${callId}`)) {
              this.seen.add(`tool:${callId}`);
              const view = toolView(name, viewInput(name, input));
              const entry: Extract<TerminalEntry, { kind: 'tool' }> = { kind: 'tool', id: id(`tool:${callId}`), at, tool: name, title: view.title };
              if (view.input) entry.input = prepare(view.input, INPUT_MAX).text;
              if (view.inputKind) entry.inputKind = view.inputKind;
              out.push(entry);
            }
          }
        }
      }
      return out.filter((e) => {
        if (this.seen.has(e.id) && e.kind !== 'tool') return false;
        this.seen.add(e.id);
        return true;
      });
    }
    if (o.type === 'turn_ended') {
      const ok = str(o.status) === 'success';
      out.push({ kind: 'system', id: id(`turn:${++this.seq}`), at, text: ok ? tr('Concluído') : tr('O Cursor terminou com erro'), level: ok ? 'info' : 'error' });
      return out;
    }
    switch (o.type) {
      case 'habblaud_meta': {
        const who = [str(o.name), str(o.role) ? `(${str(o.role)})` : ''].filter(Boolean).join(' ');
        out.push({ kind: 'system', id: id('meta'), at, text: who ? tr('Cursor: {0}', [oneLine(who, 80)]) : 'Cursor', level: 'info' });
        break;
      }
      case 'system':
        if (o.subtype === 'init') out.push({ kind: 'system', id: id(`init:${++this.seq}`), at, text: tr('Sessão {0} · {1}', [str(o.session_id) ?? '?', str(o.model) ?? '?']), level: 'info' });
        break;
      case 'user': {
        const text = textOf(o);
        if (text) out.push({ kind: 'user', id: id(`user:${++this.seq}`), at, text: marked(prepare(text, TEXT_MAX)) });
        break;
      }
      case 'thinking':
        if (o.subtype === 'delta' && str(o.text)) out.push({ kind: 'thinking', id: id(`think:${++this.seq}`), at, text: marked(prepare(String(o.text), THINKING_MAX)) });
        break;
      case 'assistant': {
        const text = textOf(o);
        if (text.trim()) out.push({ kind: 'assistant', id: id(`say:${++this.seq}`), at, text: marked(prepare(text, TEXT_MAX)) });
        break;
      }
      case 'tool_call': {
        const t = toolOf(o.tool_call);
        const callId = str(o.call_id) ?? `call${++this.seq}`;
        if (!t) break;
        const { tool } = describeCursorTool(t.key, t.args);
        if (o.subtype === 'started' || !this.seen.has(`tool:${callId}`)) {
          this.seen.add(`tool:${callId}`);
          const view = toolView(tool, viewInput(tool, t.args));
          const entry: Extract<TerminalEntry, { kind: 'tool' }> = { kind: 'tool', id: id(`tool:${callId}`), at, tool, title: view.title };
          if (view.input) entry.input = prepare(view.input, INPUT_MAX).text;
          if (view.inputKind) entry.inputKind = view.inputKind;
          out.push(entry);
        }
        if (o.subtype === 'completed') {
          const err = resultError(t.result);
          const p = prepare(resultText(t.result) || (err.error ? (err.detail ?? tr('Erro')) : tr('Feito')), RESULT_MAX, RESULT_MAX_LINES);
          out.push({ kind: 'result', id: id(`result:${callId}`), at, toolUseId: id(`tool:${callId}`), text: p.text, ...(err.error ? { error: true } : {}), ...(p.truncated ? { truncated: true } : {}) });
        }
        break;
      }
      case 'result': {
        const ms = typeof o.duration_ms === 'number' ? o.duration_ms : undefined;
        const error = o.is_error === true;
        out.push({
          kind: 'system',
          id: id(`result:${++this.seq}`),
          at,
          text: error ? tr('O Cursor terminou com erro') : ms ? tr('Concluído em {0}', [formatDuration(ms)]) : tr('Concluído'),
          level: error ? 'error' : 'info',
        });
        break;
      }
      case 'habblaud_end': {
        const code = typeof o.exitCode === 'number' ? o.exitCode : undefined;
        out.push({ kind: 'system', id: id('end'), at, text: tr('cursor-agent saiu (código {0})', [code ?? '?']), level: code ? 'warn' : 'info' });
        break;
      }
      default:
        break;
    }
    return out.filter((e) => {
      if (this.seen.has(e.id) && e.kind !== 'tool') return false;
      this.seen.add(e.id);
      return true;
    });
  }
}

export function createCursorTerminalParser(): TerminalParser {
  return new CursorTerminalParser();
}
