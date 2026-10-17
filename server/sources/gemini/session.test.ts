import { describe, expect, it } from 'vitest';
import { createGeminiState, parseGeminiLine } from './session';

describe('gemini session jsonl', () => {
  it('metadata, user e gemini com ferramenta', () => {
    const s = createGeminiState();
    const ctx = { idPrefix: 'gemini:abc', now: 1_000 };
    parseGeminiLine(
      s,
      JSON.stringify({
        sessionId: 'abc',
        projectHash: 'ph',
        directories: ['/home/x/proj'],
      }),
      ctx,
    );
    expect(s.cwd).toBe('/home/x/proj');
    parseGeminiLine(s, JSON.stringify({ type: 'user', id: 'u1', content: [{ text: 'Implemente Y' }] }), ctx);
    expect(s.title).toBe('Implemente Y');
    expect(s.started).toBe(true);
    const r = parseGeminiLine(
      s,
      JSON.stringify({
        type: 'gemini',
        id: 'g1',
        model: 'gemini-2.5-pro',
        toolCalls: [{ id: 't1', name: 'run_shell', args: { command: 'npm test' }, status: 'in_progress' }],
        content: [{ text: 'ok' }],
      }),
      ctx,
    );
    expect(r.activities[0]?.activity.tool).toBe('run_shell');
    expect(s.model).toBe('gemini-2.5-pro');
    expect(s.turnIdle).toBe(false);
  });
});
