import { describe, expect, it } from 'vitest';
import { createCursorState } from './stream';
import { parseIdeTranscriptLine, titleFromUserPrompt } from './ide-transcript';

describe('transcript do Cursor IDE', () => {
  it('titleFromUserPrompt extrai o pedido', () => {
    expect(titleFromUserPrompt('<user_query>\nOlá\n</user_query>')).toBe('Olá');
  });

  it('parseIdeTranscriptLine: user e ferramenta', () => {
    const s = createCursorState();
    const ctx = { idPrefix: 'cursor:c1', now: 1000 };
    const u = parseIdeTranscriptLine(
      s,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nFaça Y\n</user_query>' }] } }),
      ctx,
    );
    expect(s.title).toBe('Faça Y');
    expect(u.signals.some((x) => x.type === 'start')).toBe(true);
    const a = parseIdeTranscriptLine(
      s,
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }] } }),
      ctx,
    );
    expect(a.activities[0]?.activity.tool).toBe('Grep');
    expect(s.stats.toolCalls).toBe(1);
  });
});
