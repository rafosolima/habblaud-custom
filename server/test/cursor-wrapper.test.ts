// O wrapper do Cursor (mod/habblaud-cursor/run.mjs) rodado como processo, com um cursor-agent falso
// (HABBLAUD_CURSOR_BIN), HOME e pasta temporários; e o instalador (scripts/cursor-install.ts).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { binDir, COPY_NAME, install, SHIM_NAME, uninstall } from '../../scripts/cursor-install';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { CursorSource } from '../sources/cursor/source';

setQuiet(true);

const ROOT = resolve(import.meta.dirname, '..', '..');
const WRAPPER = join(ROOT, 'mod', 'habblaud-cursor', 'run.mjs');
const FAKE = join(ROOT, 'server', 'test', 'fake-cursor-agent.mjs');

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-cw-'));
  dirs.push(d);
  return d;
}

function run(args: string[], env: Record<string, string> = {}, opts: { kill?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; home: string; cursorDir: string }> {
  const home = temp();
  const cursorDir = join(home, 'cdir');
  chmodSync(FAKE, 0o755);
  return new Promise((done) => {
    const child = spawn(process.execPath, [WRAPPER, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home, HABBLAUD_CURSOR_DIR: cursorDir, HABBLAUD_CURSOR_BIN: FAKE, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    if (opts.kill) setTimeout(() => child.kill('SIGTERM'), opts.kill);
    child.on('close', (code) => done({ code, stdout, stderr, home, cursorDir }));
  });
}

function lines(cursorDir: string): Array<Record<string, unknown>> {
  const sessions = join(cursorDir, 'sessions');
  const [file] = readdirSync(sessions).filter((n) => n.endsWith('.jsonl'));
  return readFileSync(join(sessions, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('wrapper do Cursor (run.mjs)', () => {
  it('grava meta, stream (juntando os pedaços, sem env) e fim; imprime o resumo; repassa as opções e a pasta', async () => {
    const work = temp();
    const r = await run(['--name', 'Lucas', '--role', 'Dev - Mestre', '--dir', work, '--', '--model', 'composer-2.5', 'Faça X'], {
      CLAUDE_CODE_SESSION_ID: 'sess-claude',
      CLAUDE_PID: '777',
    });
    expect(r.code).toBe(0);
    const ls = lines(r.cursorDir);
    expect(ls[0]).toMatchObject({ type: 'habblaud_meta', v: 1, parentSessionId: 'sess-claude', parentPid: 777, name: 'Lucas', role: 'Dev - Mestre', cwd: work });
    expect(typeof ls[0].pid).toBe('number');
    expect(ls.at(-1)).toMatchObject({ type: 'habblaud_end', exitCode: 0 });
    const says = ls.filter((l) => l.type === 'assistant');
    expect(says).toHaveLength(1);
    expect(JSON.stringify(says[0])).toContain('args=-p --output-format stream-json --stream-partial-output --model composer-2.5 Faça X');
    const thinks = ls.filter((l) => l.type === 'thinking' && l.subtype === 'delta');
    expect(thinks).toEqual([expect.objectContaining({ text: 'Lendo o pedido.' })]);
    const raw = readFileSync(join(r.cursorDir, 'sessions', readdirSync(join(r.cursorDir, 'sessions'))[0]), 'utf8');
    expect(raw).not.toContain('SEGREDO');
    expect(r.stdout).toContain(`Feito em ${work}`);
    expect(r.stdout).toMatch(/\[Cursor · Lucas \(Dev - Mestre\) · 3s · ferramentas: 1× shell, 1× read · sessão 80b4c8ca/);
    // permissões: pasta 700, arquivo 600
    const sessions = join(r.cursorDir, 'sessions');
    expect(statSync(sessions).mode & 0o777).toBe(0o700);
    expect(statSync(join(sessions, readdirSync(sessions)[0])).mode & 0o777).toBe(0o600);
  });

  it('o arquivo gravado é lido pela fonte do Cursor (ponta a ponta)', async () => {
    const r = await run(['--name', 'Rafoso', '--role', 'Dev - Senior', '--', 'oi']);
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
    const accounts = new AccountsService({ dirs: [], home: r.home, env: {}, onChange: () => {} });
    const src = new CursorSource({ accounts, office, dir: r.cursorDir, watch: false, isAlive: () => true });
    // Encerrada há pouco e vista ao vivo: entra e sai (não some sem ser vista).
    src.poll(false);
    const a = office.list()[0];
    expect(a).toMatchObject({ provider: 'cursor', name: 'Rafoso (Dev - Senior)', status: 'offline', title: 'oi' });
  });

  it('termina com chatId: <session_id>; --resume vai para o meta (a mesma conversa)', async () => {
    const r = await run(['--name', 'Lucas', '--role', 'Dev - Mestre', '--', '--resume', 'chat-anterior', 'Corrija o teste']);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('chatId: 80b4c8ca-1111-4222-8333-944455556666');
    expect(lines(r.cursorDir)[0]).toMatchObject({ type: 'habblaud_meta', resume: 'chat-anterior' });
    const raw = await run(['--name', 'A', '--role', 'dev', '--raw', '--', 'x']);
    expect(raw.stderr).toContain('chatId: 80b4c8ca-1111-4222-8333-944455556666');
    expect(raw.stdout).not.toContain('chatId:');
  });

  it('código de saída repassado; --raw repassa o stream', async () => {
    const r = await run(['--name', 'A', '--role', 'dev', '--raw', '--', 'x'], { FAKE_CURSOR_EXIT: '3' });
    expect(r.code).toBe(3);
    expect(r.stdout.split('\n')[0]).toContain('"subtype":"init"');
    expect(lines(r.cursorDir).at(-1)).toMatchObject({ type: 'habblaud_end', exitCode: 3 });
  });

  it('SIGTERM vai para o cursor-agent', async () => {
    const r = await run(['--name', 'A', '--role', 'dev', '--', 'x'], { FAKE_CURSOR_SLEEP_MS: '5000' }, { kill: 600 });
    expect(r.code).toBe(143);
    expect(lines(r.cursorDir).at(-1)).toMatchObject({ type: 'habblaud_end', exitCode: 143 });
  });

  it('sem --name/--role ou sem pedido: uso e código 2; binário inexistente: 127', async () => {
    expect((await run(['--', 'x'])).code).toBe(2);
    expect((await run(['--name', 'A', '--role', 'dev'])).code).toBe(2);
    const missing = await run(['--name', 'A', '--role', 'dev', '--', 'x'], { HABBLAUD_CURSOR_BIN: '/nao/existe/cursor-agent' });
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain('HABBLAUD_CURSOR_BIN');
    expect(lines(missing.cursorDir).at(-1)).toMatchObject({ type: 'habblaud_end', exitCode: 127 });
  });

  it('apaga execuções com mais de 7 dias', async () => {
    const home = temp();
    const sessions = join(home, 'c', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const old = join(sessions, 'velha.jsonl');
    writeFileSync(old, '{}\n');
    const t = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, t, t);
    const child = spawn(process.execPath, [WRAPPER, '--name', 'A', '--role', 'dev', '--', 'x'], { env: { PATH: process.env.PATH ?? '', HOME: home, HABBLAUD_CURSOR_DIR: join(home, 'c'), HABBLAUD_CURSOR_BIN: FAKE } });
    await new Promise((d) => child.on('close', d));
    expect(existsSync(old)).toBe(false);
  });
});

describe('npm run cursor:install', () => {
  it('copia o wrapper e cria o atalho executável; uninstall apaga os dois', async () => {
    const home = temp();
    const out: string[] = [];
    expect(install({ home, out: (l) => out.push(l) })).toBe(0);
    const shim = join(binDir(home), SHIM_NAME);
    expect(statSync(shim).mode & 0o111).toBeTruthy();
    expect(readFileSync(join(binDir(home), COPY_NAME), 'utf8')).toBe(readFileSync(WRAPPER, 'utf8'));
    expect(out.join('\n')).toContain('--name Lucas --role "Dev - Mestre"');
    // o atalho roda de verdade
    const r = await new Promise<{ code: number | null; stdout: string }>((done) => {
      const c = spawn(shim, ['--help'], { env: { PATH: process.env.PATH ?? '', HOME: home } });
      let stdout = '';
      c.stdout.on('data', (b) => (stdout += b));
      c.on('close', (code) => done({ code, stdout }));
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Uso: habblaud-cursor');
    uninstall({ home, out: () => {} });
    expect(existsSync(shim)).toBe(false);
    expect(existsSync(join(binDir(home), COPY_NAME))).toBe(false);
  });
});
