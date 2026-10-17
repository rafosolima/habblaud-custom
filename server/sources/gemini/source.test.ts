import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { GeminiSource } from './source';

setQuiet(true);

describe('fonte do Gemini', () => {
  let clean: (() => void) | undefined;
  afterEach(() => {
    clean?.();
    clean = undefined;
  });

  it('sessão jsonl recente entra na sala do directories[0]', () => {
    const tmp = tempDir();
    clean = tmp.cleanup;
    const home = join(tmp.dir, 'home');
    const geminiHome = join(home, '.gemini');
    const projectHash = 'abc123';
    const sessionId = 'sess-uuid-full';
    const chats = join(geminiHome, 'tmp', projectHash, 'chats');
    mkdirSync(chats, { recursive: true });
    const path = join(chats, 'session-20260101-sess.jsonl');
    const cwd = '/home/x/habblaud';
    const t = Date.now();
    writeFileSync(
      path,
      [
        JSON.stringify({ sessionId, projectHash, directories: [cwd], startTime: new Date(t).toISOString() }),
        JSON.stringify({ type: 'user', id: 'u1', content: [{ text: 'Olá Gemini' }] }),
      ].join('\n') + '\n',
    );
    let clock = t;
    const now = () => clock;
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, now, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: clock,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: (id) => accounts.find(id)?.detected.name,
      now,
    });
    const source = new GeminiSource({ accounts, office, homes: [geminiHome], home, now, watch: false });
    source.boot();
    office.tick();
    const agent = office.commit().snapshot.agents.find((a) => a.id === `gemini:${sessionId}`);
    expect(agent).toMatchObject({
      kind: 'main',
      provider: 'gemini',
      roomId: cwd,
      title: 'Olá Gemini',
      status: 'working',
    });
    source.stop();
  });
});
