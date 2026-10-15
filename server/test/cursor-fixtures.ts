// Linhas sintéticas do stream-json do Cursor CLI (formato real do cursor-agent 2026, ver sources/cursor/stream.ts) e
// do wrapper do Habblaud, para os testes da fonte, do parser, do terminal e do wrapper.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SESSION = '80b4c8ca-1111-4222-8333-944455556666';

type Rec = Record<string, unknown>;
const j = (o: Rec) => JSON.stringify(o);

export const C = {
  meta: (o: { pid?: number | null; wrapperPid?: number; parentSessionId?: string | null; parentPid?: number | null; name?: string; role?: string; cwd?: string; at: number }) =>
    j({
      type: 'habblaud_meta',
      v: 1,
      pid: o.pid ?? 4242,
      wrapperPid: o.wrapperPid ?? 4241,
      parentSessionId: o.parentSessionId ?? null,
      parentPid: o.parentPid ?? null,
      name: o.name ?? null,
      role: o.role ?? null,
      cwd: o.cwd ?? '/proj/loja',
      startedAt: new Date(o.at).toISOString(),
    }),
  init: (at: number, cwd = '/proj/loja') =>
    j({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd, session_id: SESSION, model: 'Composer 2.5', permissionMode: 'default', timestamp_ms: at }),
  user: (text: string, at: number) => j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, session_id: SESSION, timestamp_ms: at }),
  thinking: (text: string, at: number) => j({ type: 'thinking', subtype: 'delta', text, session_id: SESSION, timestamp_ms: at }),
  thinkingDone: (at: number) => j({ type: 'thinking', subtype: 'completed', session_id: SESSION, timestamp_ms: at }),
  say: (text: string, at: number) => j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: SESSION, timestamp_ms: at }),
  tool: (subtype: 'started' | 'completed', callId: string, key: string, args: Rec, at: number, result?: Rec) =>
    j({
      type: 'tool_call',
      subtype,
      call_id: callId,
      tool_call: { [key]: { args, ...(result ? { result } : {}) }, toolCallId: callId, startedAtMs: String(at) },
      model_call_id: 'm1',
      session_id: SESSION,
      timestamp_ms: at,
    }),
  result: (text: string, at: number, o: { error?: boolean; usage?: Rec; ms?: number } = {}) =>
    j({ type: 'result', subtype: 'success', is_error: o.error ?? false, result: text, duration_ms: o.ms ?? 12_000, session_id: SESSION, ...(o.usage ? { usage: o.usage } : {}), timestamp_ms: at }),
  end: (at: number, exitCode = 0) => j({ type: 'habblaud_end', exitCode, at: new Date(at).toISOString() }),
};

/** Pasta temporária do wrapper (<dir>/sessions) com escrita de execuções. */
export function cursorDir() {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-cursor-'));
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  return {
    dir,
    sessions,
    write(run: string, lines: string[], mtime?: number): string {
      const p = join(sessions, `${run}.jsonl`);
      writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
      if (mtime !== undefined) utimesSync(p, mtime / 1000, mtime / 1000);
      return p;
    },
    append(run: string, lines: string[]): void {
      appendFileSync(join(sessions, `${run}.jsonl`), lines.map((l) => `${l}\n`).join(''));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
