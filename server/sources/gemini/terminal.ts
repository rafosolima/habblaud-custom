// Terminal de leitura: linhas do session-*.jsonl do Gemini CLI.
import type { TerminalEntry } from '../../../shared/types';
import type { TerminalParser } from '../terminal';
import { marked, prepare } from '../terminal';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function contentText(o: Rec): string {
  const c = o.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((p) => (typeof p === 'string' ? p : str(rec(p)?.text)))
    .filter(Boolean)
    .join('\n');
}

export function createGeminiTerminalParser(): TerminalParser {
  let seq = 0;
  const seen = new Set<string>();
  return {
    push(raw: string): TerminalEntry[] {
      let o: Rec | undefined;
      try {
        o = rec(JSON.parse(raw));
      } catch {
        return [];
      }
      if (!o) return [];
      const type = str(o.type);
      const out: TerminalEntry[] = [];
      const id = (k: string) => `gemini:${k}`;
      if (type === 'user') {
        const text = contentText(o);
        if (text) out.push({ kind: 'user', id: id(`user:${++seq}`), at: Date.now(), text: marked(prepare(text, 4_000)) });
      } else if (type === 'gemini') {
        const text = contentText(o);
        if (text?.trim()) out.push({ kind: 'assistant', id: id(`say:${++seq}`), at: Date.now(), text: marked(prepare(text, 4_000)) });
        const toolCalls = o.toolCalls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const t = rec(tc);
            if (!t) continue;
            const callId = str(t.id) ?? `call${++seq}`;
            if (seen.has(callId)) continue;
            seen.add(callId);
            const name = str(t.name) ?? 'ferramenta';
            out.push({ kind: 'tool', id: id(`tool:${callId}`), at: Date.now(), tool: name, title: name });
          }
        }
      } else if (type === 'error') {
        out.push({ kind: 'system', id: id(`err:${++seq}`), at: Date.now(), text: contentText(o) || tr('Erro'), level: 'error' });
      }
      return out;
    },
  };
}
