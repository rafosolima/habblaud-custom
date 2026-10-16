// Mantém o npm run cursor:bridge rodando em segundo plano (systemd --user no Linux).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_BIN = join(ROOT, 'node_modules', '.bin', 'tsx');
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const BRIDGE = join(ROOT, 'scripts', 'cursor-bridge.ts');
const UNIT_NAME = 'habblaud-cursor-bridge.service';

function stateDir(home: string): string {
  return join(home, '.habblaud');
}

function unitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', UNIT_NAME);
}

function logPath(home: string): string {
  return join(stateDir(home), 'cursor-bridge.log');
}

function renderUnit(home: string, port: string | undefined, nodeBin: string): string {
  const envPort = port ? `Environment=HABBLAUD_PORT=${port}\n` : '';
  const exec = existsSync(TSX_CLI) ? `${nodeBin} ${TSX_CLI} ${BRIDGE}` : `${TSX_BIN} ${BRIDGE}`;
  const pathEnv = process.env.PATH?.trim();
  const pathLine = pathEnv ? `Environment=PATH=${pathEnv}\n` : '';
  return `[Unit]
Description=Habblaud — entrega mensagens do escritório ao Cursor (cursor-bridge)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${exec}
${pathLine}${envPort}Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath(home)}
StandardError=append:${logPath(home)}

[Install]
WantedBy=default.target
`;
}

function systemctl(home: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}` } });
    return { ok: true, out: out.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, out: [e.stdout, e.stderr].filter(Boolean).join('\n').trim() };
  }
}

function install(home: string): number {
  if ((!existsSync(TSX_BIN) && !existsSync(TSX_CLI)) || !existsSync(BRIDGE)) {
    console.error(tr('Rode npm install na pasta do Habblaud ({0}).', [ROOT]));
    return 2;
  }
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(unitPath(home)), { recursive: true, mode: 0o755 });
  const port = process.env.HABBLAUD_PORT?.trim();
  writeFileSync(unitPath(home), renderUnit(home, port, process.execPath), { mode: 0o644 });
  systemctl(home, ['daemon-reload']);
  console.log(tr('Serviço instalado: {0}', [unitPath(home)]));
  console.log(tr('Log: {0}', [logPath(home)]));
  return 0;
}

function uninstall(home: string): number {
  systemctl(home, ['stop', UNIT_NAME]);
  systemctl(home, ['disable', UNIT_NAME]);
  try {
    rmSync(unitPath(home));
  } catch {
    // já foi
  }
  systemctl(home, ['daemon-reload']);
  console.log(tr('Serviço do cursor-bridge removido.'));
  return 0;
}

function start(home: string): number {
  const c = install(home);
  if (c !== 0) return c;
  const en = systemctl(home, ['enable', '--now', UNIT_NAME]);
  if (!en.ok) {
    console.error(tr('Não consegui iniciar: {0}', [en.out || tr('systemctl falhou')]));
    return 1;
  }
  console.log(tr('cursor-bridge rodando em segundo plano (systemd --user).'));
  console.log(tr('  status: npm run cursor:bridge:status'));
  console.log(tr('  parar:  npm run cursor:bridge:stop'));
  return 0;
}

function stop(home: string): number {
  systemctl(home, ['stop', UNIT_NAME]);
  console.log(tr('cursor-bridge parado.'));
  return 0;
}

function status(home: string): number {
  if (!existsSync(unitPath(home))) {
    console.log(tr('Serviço não instalado. Rode: npm run cursor:bridge:start'));
    return 1;
  }
  const st = systemctl(home, ['is-active', UNIT_NAME]);
  const active = st.out === 'active';
  console.log(active ? tr('cursor-bridge: ativo (systemd --user).') : tr('cursor-bridge: inativo ({0}).', [st.out || '?']));
  if (existsSync(logPath(home))) {
    const tail = readFileSync(logPath(home), 'utf8').split('\n').slice(-3).filter(Boolean);
    if (tail.length) console.log(tail.join('\n'));
  }
  return active ? 0 : 1;
}

function main(): void {
  const cmd = process.argv[2];
  const home = process.env.HOME || homedir();
  const usage = tr('Uso: npm run cursor:bridge:start | stop | status | install | uninstall');
  let code = 0;
  switch (cmd) {
    case 'install':
      code = install(home);
      break;
    case 'uninstall':
      code = uninstall(home);
      break;
    case 'start':
      code = start(home);
      break;
    case 'stop':
      code = stop(home);
      break;
    case 'status':
      code = status(home);
      break;
    default:
      console.log(usage);
      code = cmd ? 1 : 0;
  }
  process.exitCode = code;
}

main();
