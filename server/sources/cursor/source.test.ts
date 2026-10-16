// Integração da fonte do Cursor: uma pasta temporária do wrapper (execuções sintéticas), o AccountsService e o Office.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import type { TeamLookup, TeamMember } from '../../model/team';
import { C, cursorDir, SESSION } from '../../test/cursor-fixtures';
import { SourceSet } from '../source';
import { CursorSource, ENTER_AFTER_MS, STALE_MS } from './source';

setQuiet(true);

const AID = `cursor:${SESSION}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(opts: { alive?: Set<number>; inDocker?: boolean; team?: TeamMember[]; chatRoots?: string[]; home?: string } = {}) {
  const dir = cursorDir();
  cleanups.push(dir.cleanup);
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: dir.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const members = opts.team ?? [];
  const team: TeamLookup = {
    subagent: (t) => members.find((m) => m.agentType === t),
    cursor: (n) => members.find((m) => m.cursorName?.toLowerCase() === n.toLowerCase()),
    cursorIdeDefault: () => {
      const picks = members.filter((m) => m.cursorIdeDefault);
      return picks.length === 1 ? picks[0] : undefined;
    },
    main: () => members.find((m) => m.main),
  };
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    team,
    now,
  });
  late.office = office;
  const alive = opts.alive ?? new Set([4242]);
    const source = new CursorSource({
    accounts,
    office,
    dir: dir.dir,
    chatRoots: opts.chatRoots,
    home: opts.home,
    team,
    now,
    watch: false,
    inDocker: opts.inDocker,
    isAlive: (pid) => alive.has(pid),
  });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    dir,
    accounts,
    office,
    source,
    alive,
    notices,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agent(id = AID): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    claudeMain(sessionId = 'sess-claude', pid = 777) {
      office.addMain({ id: `.claude:${pid}`, account: '.claude', sessionId, cwd: '/proj/techlead', role: 'Agente principal', startedAt: clock, status: 'working' });
    },
  };
}

describe('fonte do Cursor: execuções do wrapper no escritório', () => {
  it('sem chamador conhecido: agente principal na sala do cwd, com nome (papel), badge do Cursor e a conta Cursor', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t - 3_000, name: 'Lucas', role: 'Dev - Mestre' }), C.init(t - 2_500), C.user('Implemente o endpoint', t - 2_000), C.tool('started', 'c1', 'shellToolCall', { command: 'npm test' }, t - 1_000)]);
    ctx.source.boot();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'cursor',
      account: '.cursor',
      sessionId: SESSION,
      roomId: '/proj/loja',
      name: 'Lucas (Dev - Mestre)',
      role: 'Dev - Mestre',
      status: 'working',
      title: 'Implemente o endpoint',
      model: 'Composer 2.5',
    });
    expect(a.activity?.text).toBe('Rodando testes');
    expect(ctx.office.commit().snapshot.accounts.find((x) => x.id === '.cursor')).toMatchObject({ provider: 'cursor', short: 'A', name: 'Conta A' });
    expect(ctx.source.sources()).toEqual([{ label: '.cursor', provider: 'cursor', path: ctx.dir.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(AID)).toMatch(/r1\.jsonl$/);
    expect(new SourceSet([ctx.source]).parserFor(AID).push(C.user('oi', 1))).toEqual([expect.objectContaining({ kind: 'user', text: 'oi' })]);
  });

  it('chamado por uma sessão aberta do Claude Code: subagente dela, com provider e conta do Cursor; o resultado entrega', () => {
    const ctx = setup();
    ctx.claudeMain('sess-claude');
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Rafoso', role: 'Dev - Senior', parentSessionId: 'sess-claude' }), C.init(t + 10), C.user('Corrija o bug', t + 20)]);
    ctx.poll();
    const a = ctx.agent()!;
    expect(a).toMatchObject({ kind: 'sub', parentId: '.claude:777', roomId: '/proj/techlead', provider: 'cursor', account: '.cursor', name: 'Rafoso (Dev - Senior)', title: 'Corrija o bug', status: 'working' });
    ctx.dir.append('r1', [C.say('Corrigido.', t + 100), C.result('Corrigido.', t + 200)]);
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('done');
    expect(ctx.notices.some((n) => n.text.includes('Rafoso (Dev - Senior) entregou'))).toBe(true);
    ctx.dir.append('r1', [C.end(t + 300)]);
    ctx.poll();
    expect(ctx.source.transcriptPathOf(AID)).toBeUndefined();
  });

  it('liga pelo CLAUDE_PID quando não há sessão no meta', () => {
    const ctx = setup();
    ctx.claudeMain('outra', 999);
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Ana', role: 'dev', parentPid: 999 }), C.init(t)]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ kind: 'sub', parentId: '.claude:999' });
  });

  it('principal: resultado = ocioso (Concluiu); fim = encerra', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Felipe', role: 'Dev - Senior' }), C.init(t), C.user('Faça X', t)]);
    ctx.poll();
    ctx.dir.append('r1', [C.result('Feito', t + 50)]);
    ctx.advance(500);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('idle');
    ctx.dir.append('r1', [C.end(t + 60)]);
    ctx.advance(500);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('offline');
  });

  it('processo morto sem fim: sai; no boot é ignorado', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Julia', role: 'qa' }), C.init(t)]);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('working');
    ctx.alive.clear();
    ctx.advance(500);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('offline');

    const boot = setup({ alive: new Set() });
    boot.dir.write('r1', [C.meta({ at: boot.now(), name: 'Julia', role: 'qa' }), C.init(boot.now())]);
    boot.source.boot();
    expect(boot.agent()).toBeUndefined();
  });

  it('boot: execuções encerradas ou com mais de 24 h ficam de fora', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t - 5_000, name: 'A', role: 'dev' }), C.init(t - 5_000), C.end(t - 4_000)]);
    ctx.dir.write('r2', [C.meta({ at: t - STALE_MS - 10_000, name: 'B', role: 'dev' }), C.init(t - STALE_MS - 10_000)], t - STALE_MS - 5_000);
    ctx.source.boot();
    expect(ctx.office.list()).toEqual([]);
  });

  it('só o meta: espera o init antes de entrar (ou ENTER_AFTER_MS)', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Lucas', role: 'Dev - Mestre' })]);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
    ctx.advance(ENTER_AFTER_MS + 10);
    ctx.poll();
    expect(ctx.agent('cursor:r1')).toMatchObject({ name: 'Lucas (Dev - Mestre)', sessionId: 'r1' });
  });

  it('o mesmo dev duas vezes ao mesmo tempo: "Lucas 2 (Dev - Mestre)"; a equipe dá o papel', () => {
    const ctx = setup({ team: [{ cursorName: 'Lucas', name: 'Lucas', role: 'Dev - Mestre' }] });
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'lucas', role: 'outro' }), C.init(t)]);
    ctx.dir.write('r2', [C.meta({ at: t, name: 'Lucas', role: 'Dev - Mestre' }), C.init(t)]);
    ctx.poll();
    const names = ctx.office.list().map((a) => a.name).sort();
    expect(names).toEqual(['Lucas (Dev - Mestre)', 'Lucas 2 (Dev - Mestre)']);
    const [a, b] = ctx.office.list();
    expect(a.seed).toBe(b.seed);
  });

  it('no Docker: sem conferir PIDs, vale a escrita recente', () => {
    const ctx = setup({ inDocker: true, alive: new Set() });
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Isa', role: 'Product Owner' }), C.init(t)]);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('working');
  });

  it('--resume da mesma conversa: arquivo novo, MESMO personagem (principal no período de graça e subagente)', () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.dir.write('r1', [C.meta({ at: t, name: 'Lucas', role: 'Dev - Mestre' }), C.init(t), C.user('Faça X', t), C.result('ok', t + 1), C.end(t + 2)]);
    ctx.poll();
    expect(ctx.agent()!.status).toBe('offline');
    // a correção, retomando a conversa: volta o mesmo agente (não "Lucas 2")
    ctx.advance(2_000);
    const resumed = JSON.stringify({ ...JSON.parse(C.meta({ at: ctx.now(), name: 'Lucas', role: 'Dev - Mestre' })), resume: SESSION });
    ctx.dir.write('r2', [resumed, C.init(ctx.now()), C.user('Corrija o teste', ctx.now())]);
    ctx.poll();
    const agents = ctx.office.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: AID, name: 'Lucas (Dev - Mestre)', status: 'working' });
    expect(ctx.source.transcriptPathOf(AID)).toMatch(/r2\.jsonl$/);

    // subagente do Tech Lead: entrega, e o --resume o põe para trabalhar de novo
    const sub = setup();
    sub.claudeMain('sess-claude');
    const t2 = sub.now();
    sub.dir.write('r1', [C.meta({ at: t2, name: 'Rafoso', role: 'Dev - Senior', parentSessionId: 'sess-claude' }), C.init(t2), C.result('ok', t2 + 1), C.end(t2 + 2)]);
    sub.poll();
    expect(sub.agent()!.status).toBe('done');
    const again = JSON.stringify({ ...JSON.parse(C.meta({ at: t2 + 5, name: 'Rafoso', role: 'Dev - Senior', parentSessionId: 'sess-claude' })), resume: SESSION });
    sub.dir.write('r2', [again, C.init(t2 + 5)]);
    sub.advance(1_000);
    sub.poll();
    expect(sub.office.list().filter((a) => a.provider === 'cursor')).toEqual([expect.objectContaining({ id: AID, name: 'Rafoso (Dev - Senior)', status: 'working' })]);
  });

  it('sem a pasta: nenhuma conta nem fonte', () => {
    const ctx = setup();
    ctx.dir.cleanup();
    ctx.poll();
    expect(ctx.source.sources()).toEqual([]);
    expect(ctx.source.accountEntry()).toBeUndefined();
  });
});

describe('fonte do Cursor: chats do IDE / cursor-agent', () => {
  it('transcript jsonl: entra na sala certa, com título, atividade e terminal', () => {
    const tmp = cursorDir();
    cleanups.push(tmp.cleanup);
    const home = join(tmp.dir, 'home');
    const chatRoot = join(home, '.cursor');
    const chatId = 'aead4f1f-test';
    const cwd = '/home/x/habblaud';
    const chatDir = join(chatRoot, 'chats', 'proj', chatId);
    mkdirSync(chatDir, { recursive: true });
    const t = Date.now();
    writeFileSync(
      join(chatDir, 'meta.json'),
      JSON.stringify({ updatedAtMs: t, cwd, title: 'Habblaud Cursor Agent', hasConversation: true }),
    );
    const slug = 'home-x-habblaud';
    const transcript = join(chatRoot, 'projects', slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    mkdirSync(join(transcript, '..'), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nImplemente X\n</user_query>' }] } }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/home/x/habblaud/README.md' } }] },
        }),
      ].join('\n'),
    );
    const ctx = setup({ chatRoots: [chatRoot], home });
    ctx.source.boot();
    ctx.poll();
    const id = `cursor:${chatId}`;
    expect(ctx.agent(id)).toMatchObject({
      kind: 'main',
      provider: 'cursor',
      account: '.cursor',
      roomId: cwd,
      title: 'Implemente X',
      status: 'working',
    });
    expect(ctx.source.transcriptPathOf(id)).toBe(transcript);
    expect(new SourceSet([ctx.source]).parserFor(id).push(JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'oi' }] } }))).toEqual([
      expect.objectContaining({ kind: 'user' }),
    ]);
  });

  it('chat do IDE com nome genérico no store.db usa cursorIdeDefault do team.json', () => {
    const tmp = cursorDir();
    cleanups.push(tmp.cleanup);
    const home = join(tmp.dir, 'home');
    const chatRoot = join(home, '.cursor');
    const chatId = 'ide-generic-name';
    const cwd = '/home/x/habblaud';
    const chatDir = join(chatRoot, 'chats', 'p', chatId);
    mkdirSync(chatDir, { recursive: true });
    const t = Date.now();
    writeFileSync(join(chatDir, 'meta.json'), JSON.stringify({ updatedAtMs: t, cwd, title: 'Habblaud Cursor Agent', hasConversation: true }));
    const hex = Buffer.from(JSON.stringify({ name: 'Habblaud Cursor Agent', lastUsedModel: 'composer-2.5' }), 'utf8').toString('hex');
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(chatDir, 'store.db'));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(hex);
    db.close();
    const slug = 'home-x-habblaud';
    const transcript = join(chatRoot, 'projects', slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    mkdirSync(join(transcript, '..'), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nOi\n</user_query>' }] } }) + '\n',
    );
    const ctx = setup({
      chatRoots: [chatRoot],
      home,
      team: [{ cursorName: 'Lucas', name: 'Lucas', role: 'Dev - Mestre', cursorIdeDefault: true }],
    });
    ctx.source.boot();
    ctx.poll();
    expect(ctx.agent(`cursor:${chatId}`)).toMatchObject({ name: 'Lucas (Dev - Mestre)', provider: 'cursor' });
  });

  it('subagente no transcript do pai entra ligado ao principal Cursor', () => {
    const tmp = cursorDir();
    cleanups.push(tmp.cleanup);
    const home = join(tmp.dir, 'home');
    const chatRoot = join(home, '.cursor');
    const parentId = 'parent-uuid';
    const subId = 'sub-uuid';
    const cwd = '/home/x/habblaud';
    const slug = 'home-x-habblaud';
    mkdirSync(join(chatRoot, 'chats', 'p', parentId), { recursive: true });
    const t = Date.now();
    writeFileSync(join(chatRoot, 'chats', 'p', parentId, 'meta.json'), JSON.stringify({ updatedAtMs: t, cwd, hasConversation: true }));
    const mainPath = join(chatRoot, 'projects', slug, 'agent-transcripts', parentId, `${parentId}.jsonl`);
    const subPath = join(chatRoot, 'projects', slug, 'agent-transcripts', parentId, 'subagents', `${subId}.jsonl`);
    mkdirSync(join(subPath, '..'), { recursive: true });
    writeFileSync(
      mainPath,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nPai\n</user_query>' }] } }) + '\n',
    );
    writeFileSync(
      subPath,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nExplorar repo\n</user_query>' }] } }) + '\n',
    );
    const ctx = setup({ chatRoots: [chatRoot], home });
    ctx.source.boot();
    ctx.poll();
    const parent = ctx.agent(`cursor:${parentId}`);
    expect(parent?.kind).toBe('main');
    const sub = ctx.office.commit().snapshot.agents.find((a) => a.id === `cursor:${subId}`);
    expect(sub).toMatchObject({ kind: 'sub', parentId: `cursor:${parentId}`, provider: 'cursor', title: 'Explorar repo' });
  });
});
