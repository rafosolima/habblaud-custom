import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  CURSOR_RECENT_MS,
  discoverCursorRoots,
  isCursorPresent,
  isCursorWorking,
  listCursorChats,
  listSubagentTranscripts,
} from './files';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function cursorRoot(home: string, name = '.cursor'): string {
  const root = join(home, name);
  mkdirSync(join(root, 'chats', 'proj-hash', 'chat-1'), { recursive: true });
  return root;
}

function writeMeta(chatDir: string, meta: Record<string, unknown>): void {
  writeFileSync(join(chatDir, 'meta.json'), JSON.stringify(meta));
}

describe('pastas e chats do Cursor', () => {
  it('discoverCursorRoots: ~/.cursor com chats/ ou HABBLAUD_CURSOR_CHATS_DIRS', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const home = tmp.dir;
    expect(discoverCursorRoots({}, home)).toEqual([]);
    const root = cursorRoot(home);
    expect(discoverCursorRoots({}, home)).toEqual([root]);
    expect(discoverCursorRoots({ HABBLAUD_CURSOR_CHATS_DIRS: '/outro' }, home)).toEqual([]);
    mkdirSync(join(home, 'outro', 'chats'), { recursive: true });
    expect(discoverCursorRoots({ HABBLAUD_CURSOR_CHATS_DIRS: join(home, 'outro') }, home)).toEqual([join(home, 'outro')]);
  });

  it('listCursorChats lê meta.json; subagente e sem cwd entram na lista bruta', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const root = cursorRoot(tmp.dir);
    const chatDir = join(root, 'chats', 'proj-hash', 'chat-1');
    const now = 1_000_000;
    writeMeta(chatDir, { updatedAtMs: now, cwd: '/proj', title: 'Oi' });
    const all = listCursorChats(root);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ chatId: 'chat-1', cwd: '/proj', title: 'Oi', updatedAtMs: now, isSubagent: false });
  });

  it('listSubagentTranscripts acha subagentes sob o transcript do pai', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const home = tmp.dir;
    const parent = 'parent-chat-id';
    const cwd = '/home/x/proj';
    const slug = 'home-x-proj';
    const subId = 'sub-abc';
    const main = join(home, '.cursor', 'projects', slug, 'agent-transcripts', parent, `${parent}.jsonl`);
    const sub = join(home, '.cursor', 'projects', slug, 'agent-transcripts', parent, 'subagents', `${subId}.jsonl`);
    mkdirSync(join(sub, '..'), { recursive: true });
    writeFileSync(main, '{}');
    writeFileSync(sub, '{}');
    const list = listSubagentTranscripts(home, parent, cwd);
    expect(list).toEqual([expect.objectContaining({ subId, parentChatId: parent, path: sub, cwd })]);
  });

  it('presença e working pelas janelas de tempo', () => {
    const now = 10_000_000;
    const hot = { chatId: 'c', dir: '/x', updatedAtMs: now - 30_000, isSubagent: false };
    const warm = { chatId: 'c', dir: '/x', updatedAtMs: now - 10 * 60_000, isSubagent: false };
    const cold = { chatId: 'c', dir: '/x', updatedAtMs: now - CURSOR_RECENT_MS - 60_000, isSubagent: false };
    expect(isCursorWorking(hot, now)).toBe(true);
    expect(isCursorWorking(warm, now)).toBe(false);
    expect(isCursorPresent(warm, now)).toBe(true);
    expect(isCursorPresent(cold, now)).toBe(false);
  });
});
