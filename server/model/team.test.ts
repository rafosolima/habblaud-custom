import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hash32 } from '../../shared/hash';
import { setQuiet } from '../log';
import { NameStore } from './names';
import { Office } from './office';
import { parseTeam, RECHECK_MS, TeamRoster } from './team';

setQuiet(true);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const ROSTER = {
  members: [
    { agentType: 'renato-techlead', name: 'Renato', role: 'TechLead', main: true, cwd: '/proj' },
    { agentType: 'tati-po', name: 'Tati', role: 'Product Owner' },
    { agentType: 'julia-qa', name: 'Julia', role: 'qa - test' },
    { cursorName: 'Lucas', name: 'Lucas', role: 'Dev - Mestre' },
    { name: 'Sem casamento' },
    { agentType: 'x', name: '' },
    'lixo',
  ],
};

function office(team?: TeamRoster) {
  let clock = 1_000_000;
  const o = new Office({ names: new NameStore(null), version: 't', startedAt: clock, accounts: () => [], sources: () => [], accountName: () => undefined, team, now: () => clock });
  return { o, advance: (ms: number) => (clock += ms) };
}

function roster(content: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-team-'));
  dirs.push(dir);
  const file = join(dir, 'team.json');
  writeFileSync(file, JSON.stringify(content));
  let clock = 0;
  const r = new TeamRoster(file, { now: () => clock });
  return { r, file, advance: (ms: number) => (clock += ms) };
}

describe('team.json', () => {
  it('lê só os membros válidos e casa por tipo de subagente, nome do Cursor e sessão principal', () => {
    expect(parseTeam(ROSTER).map((m) => m.name)).toEqual(['Renato', 'Tati', 'Julia', 'Lucas']);
    const { r } = roster(ROSTER);
    expect(r.subagent('TATI-PO')?.name).toBe('Tati');
    expect(r.cursor('lucas')?.role).toBe('Dev - Mestre');
    expect(r.main('/proj/loja')?.name).toBe('Renato');
    expect(r.main('/outro')).toBeUndefined();
    expect(r.subagent('desconhecido')).toBeUndefined();
  });

  it('relê quando o arquivo muda; sem arquivo, sem equipe', () => {
    const { r, file, advance } = roster({ members: [{ agentType: 'a', name: 'Ana' }] });
    expect(r.subagent('a')?.name).toBe('Ana');
    writeFileSync(file, JSON.stringify({ members: [{ agentType: 'a', name: 'Bia', role: 'Dev' }] }));
    advance(RECHECK_MS + 1);
    // mtime pode cair no mesmo ms: força um mtime novo
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(r.subagent('a')?.name).toBe('Bia');
    rmSync(file);
    advance(RECHECK_MS + 1);
    expect(r.list()).toEqual([]);
    expect(new TeamRoster(null).list()).toEqual([]);
    writeFileSync(file, '{ quebrado');
    advance(RECHECK_MS + 1);
    expect(r.list()).toEqual([]);
  });
});

describe('Office com a equipe', () => {
  it('subagente do tipo da equipe: "Nome (Papel)", aparência fixa pelo nome; os outros seguem o sorteio', () => {
    const { r } = roster(ROSTER);
    const { o } = office(r);
    o.addMain({ id: 'c:1', account: 'c', sessionId: 's1', cwd: '/proj/loja', role: 'Agente principal', startedAt: 1, status: 'working' });
    expect(o.get('c:1')).toMatchObject({ name: 'Renato (TechLead)', role: 'TechLead', seed: hash32('team:renato') });
    o.addSub({ id: 's1:a', parentId: 'c:1', sessionId: 's1', role: 'tati-po', background: false, startedAt: 1, identity: { agentType: 'tati-po' } });
    o.addSub({ id: 's1:b', parentId: 'c:1', sessionId: 's1', role: 'Explore', background: false, startedAt: 1, identity: { agentType: 'Explore' } });
    expect(o.get('s1:a')).toMatchObject({ name: 'Tati (Product Owner)', role: 'Product Owner', seed: hash32('team:tati') });
    expect(o.get('s1:b')!.name).not.toMatch(/\(/);
    // a mesma pessoa duas vezes
    o.addSub({ id: 's1:c', parentId: 'c:1', sessionId: 's1', role: 'tati-po', background: false, startedAt: 1, identity: { agentType: 'tati-po' } });
    expect(o.get('s1:c')!.name).toBe('Tati 2 (Product Owner)');
  });

  it('personagem do projeto vence a regra main da equipe; fora da pasta, sorteio', () => {
    const { r } = roster(ROSTER);
    const names = new NameStore(null);
    names.setCharacter('/proj/loja', { name: 'Zé', look: 'm', seed: 7 });
    const o = new Office({ names, version: 't', startedAt: 1, accounts: () => [], sources: () => [], accountName: () => undefined, team: r });
    o.addMain({ id: 'c:1', account: 'c', sessionId: 's1', cwd: '/proj/loja', role: 'Agente principal', startedAt: 1, status: 'idle' });
    expect(o.get('c:1')).toMatchObject({ name: 'Zé', custom: true });
    o.addMain({ id: 'c:2', account: 'c', sessionId: 's2', cwd: '/fora', role: 'Agente principal', startedAt: 1, status: 'idle' });
    expect(o.get('c:2')!.name).not.toMatch(/Renato/);
    // Codex nunca recebe a regra main do Claude Code
    o.addMain({ id: 'x:1', provider: 'codex', account: 'x', sessionId: 's3', cwd: '/proj/b', role: 'Agente principal', startedAt: 1, status: 'idle' });
    expect(o.get('x:1')!.name).not.toMatch(/Renato/);
  });

  it('sem team.json nada muda', () => {
    const a = office();
    const b = office(new TeamRoster(join(tmpdir(), 'nao-existe-habblaud', 'team.json')));
    for (const { o } of [a, b]) {
      o.addMain({ id: 'c:1', account: 'c', sessionId: 's1', cwd: '/proj', role: 'Agente principal', startedAt: 1, status: 'idle' });
      o.addSub({ id: 's1:a', parentId: 'c:1', sessionId: 's1', role: 'tati-po', background: false, startedAt: 1, identity: { agentType: 'tati-po' } });
    }
    expect(b.o.get('c:1')!.name).toBe(a.o.get('c:1')!.name);
    expect(b.o.get('s1:a')).toMatchObject({ name: a.o.get('s1:a')!.name, role: 'tati-po', seed: hash32('s1:a') });
  });
});
