// A fonte do Cursor pelas rotas: /api/health (fonte e conta), /api/snapshot (agente com provider) e o terminal.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot, TerminalEntry } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { createApiHandler } from '../../http/app';
import { Hub } from '../../http/sse';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { C, cursorDir, SESSION } from '../../test/cursor-fixtures';
import { SourceSet } from '../source';
import { CursorSource } from './source';
import { createCursorTerminalParser } from './terminal';

setQuiet(true);

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

describe('Cursor nas rotas', () => {
  it('/api/health lista a fonte e a conta do Cursor; o snapshot traz o agente com provider cursor', async () => {
    const dir = cursorDir();
    cleanups.push(dir.cleanup);
    const late: { office?: Office } = {};
    const accounts = new AccountsService({ dirs: [], home: dir.dir, env: {}, onChange: () => late.office?.markDirty() });
    const sources: { set?: SourceSet } = {};
    const office = new Office({ names: new NameStore(null), version: '1', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => sources.set?.sources() ?? [], accountName: () => undefined });
    late.office = office;
    const source = new CursorSource({ accounts, office, dir: dir.dir, watch: false, isAlive: () => true });
    sources.set = new SourceSet([source]);
    dir.write('r1', [C.meta({ at: Date.now(), name: 'Lucas', role: 'Dev - Mestre' }), C.init(Date.now())]);
    source.boot();
    const hub = new Hub(office, { throttleMs: 10 });
    hub.start();
    const api = createApiHandler({ office, hub, accounts, sources: () => sources.set!.sources(), version: '1', inDocker: false });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    cleanups.unshift(
      () =>
        new Promise<void>((ok) => {
          hub.stop();
          source.stop();
          server.closeAllConnections();
          server.close(() => ok());
        }),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { sources: unknown[]; accounts: unknown[] };
    expect(health.sources).toEqual([{ label: '.cursor', provider: 'cursor', path: dir.dir, sessions: 1, ok: true }]);
    expect(health.accounts).toEqual([{ id: '.cursor', provider: 'cursor', usageStatus: 'disabled' }]);
    const snap = (await (await fetch(`${base}/api/snapshot`)).json()) as OfficeSnapshot;
    expect(snap.agents).toEqual([expect.objectContaining({ id: `cursor:${SESSION}`, provider: 'cursor', name: 'Lucas (Dev - Mestre)' })]);
    expect(snap.agents[0].canMessage).toBeUndefined();
  });
});

describe('terminal do Cursor', () => {
  it('pedido, raciocínio, ferramenta com resultado, resposta e fim', () => {
    const p = createCursorTerminalParser();
    const out: TerminalEntry[] = [];
    for (const l of [
      C.meta({ at: 1, name: 'Lucas', role: 'Dev - Mestre' }),
      C.init(2),
      C.user('Rode os testes', 3),
      C.thinking('Vou rodar.', 4),
      C.tool('started', 't1', 'shellToolCall', { command: 'npm test' }, 5),
      C.tool('completed', 't1', 'shellToolCall', { command: 'npm test' }, 6, { success: { exitCode: 0, stdout: 'ok 3 testes' } }),
      C.tool('completed', 't2', 'readToolCall', { path: '/p/a.txt' }, 7, { error: { error: 'não existe' } }),
      C.say('Tudo verde.', 8),
      C.result('Tudo verde.', 9),
      C.end(10),
      'não é json',
    ])
      out.push(...p.push(l));
    expect(out.map((e) => e.kind)).toEqual(['system', 'system', 'user', 'thinking', 'tool', 'result', 'tool', 'result', 'assistant', 'system', 'system']);
    expect(out[0]).toMatchObject({ text: 'Cursor: Lucas (Dev - Mestre)' });
    expect(out[4]).toMatchObject({ kind: 'tool', tool: 'Bash', title: 'Bash(npm test)' });
    expect(out[5]).toMatchObject({ kind: 'result', text: 'ok 3 testes', toolUseId: out[4].id });
    expect(out[7]).toMatchObject({ kind: 'result', error: true, text: 'não existe' });
    expect(out[9]).toMatchObject({ text: 'Concluído em 12s' });
  });
});
