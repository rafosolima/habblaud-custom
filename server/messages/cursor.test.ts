import { describe, expect, it } from 'vitest';
import { CHAT_ID, findCursorBin, resumeArgs } from './cursor';

describe('cursor messages', () => {
  it('resumeArgs', () => {
    expect(resumeArgs('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'olá')).toEqual([
      '-p',
      '--resume',
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      '--force',
      'olá',
    ]);
  });

  it('CHAT_ID', () => {
    expect(CHAT_ID.test('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe(true);
    expect(CHAT_ID.test('nope')).toBe(false);
  });

  it('findCursorBin usa HABBLAUD_CURSOR_BIN', () => {
    expect(findCursorBin({ HABBLAUD_CURSOR_BIN: '/x/agent' }, (p) => p === '/x/agent')).toBe('/x/agent');
    expect(findCursorBin({ HABBLAUD_CURSOR_BIN: '/missing' }, () => false)).toBeUndefined();
  });
});
