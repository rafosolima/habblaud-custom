// Instala (ou remove) os hooks de permissão do Habblaud no Cursor IDE (~/.cursor/hooks.json). Roda no HOST, com tsx:
//
//   npm run cursor:hooks:install     # acrescenta preToolUse, beforeShellExecution e beforeMCPExecution
//   npm run cursor:hooks:uninstall   # tira só os handlers do Habblaud
//   npm run cursor:hooks:status      # mostra se estão lá e se o Habblaud responde
//
// O hook (mod/habblaud-cursor-permissoes/hook.mjs) registra pedidos em POST /api/permissions (provider cursor)
// e espera a decisão no escritório antes de devolver allow/deny ao Cursor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quotePath } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-cursor-permissoes', 'hook.mjs');
const HOOK_MARK = /habblaud-cursor-permissoes[\\/]+hook\.mjs/;
export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
export const MIN_TIMEOUT_S = 5;
export const MAX_TIMEOUT_S = 600;
export const CONFIG_NAME = 'cursor-hook.json';
/** Eventos em que o Habblaud pede aprovação antes da ferramenta rodar. */
export const EVENTS = ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution'] as const;
const PERMISSION_SLACK_S = 10;

const USAGE = tr(
  'Uso: npm run cursor:hooks:<install|uninstall|status> [-- opções]\n\n  install     acrescenta os hooks do Habblaud em ~/.cursor/hooks.json (faz backup antes)\n  uninstall   tira os hooks do Habblaud (os outros ficam)\n  status      mostra se os hooks estão lá e se o Habblaud responde\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --timeout <s>    quanto o hook espera sua resposta no Habblaud (padrão: {1} s; entre {2} e {3})\n  --auto-allow     o hook sempre devolve allow ao Cursor (não espera o escritório)\n  --node <caminho> Node que roda o hook (padrão: o deste comando)\n  -h, --help       mostra esta ajuda\n\nDepois de instalar, abra o Cursor e aprove os hooks na aba Hooks (ou reinicie o IDE).',
  [DEFAULT_PORT, DEFAULT_TIMEOUT_S, MIN_TIMEOUT_S, MAX_TIMEOUT_S],
);

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function hookCommand(scriptPath: string, nodeBin?: string): string {
  return `${nodeBin ? quotePath(nodeBin) : 'node'} ${quotePath(scriptPath)}`;
}

export function permissionTimeout(waitS: number): number {
  return waitS + PERMISSION_SLACK_S;
}

export function handlerFor(command: string, waitS: number): Rec {
  return { command, timeout: permissionTimeout(waitS) };
}

export function isOurHandler(h: unknown): boolean {
  const r = rec(h);
  return !!r && typeof r.command === 'string' && HOOK_MARK.test(r.command);
}

export interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, unknown[]>;
}

export type PlanAction =
  | { action: 'install'; file: CursorHooksFile; message: string; events: string[] }
  | { action: 'uninstall'; file: CursorHooksFile; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

function hooksOf(file: CursorHooksFile): Rec | string {
  if (file.hooks !== undefined && !rec(file.hooks)) return tr('"hooks" em formato desconhecido; nada foi alterado');
  const hooks = rec(file.hooks) ?? {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) return tr('"hooks.{0}" em formato desconhecido; nada foi alterado', [event]);
  }
  return hooks;
}

function ourIndex(list: unknown[]): number {
  return list.findIndex((h) => isOurHandler(h));
}

export function planInstall(file: CursorHooksFile, command: string, waitS: number): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  const handler = handlerFor(command, waitS);
  const touched: string[] = [];
  for (const event of EVENTS) {
    const list = [...((hooks[event] as unknown[] | undefined) ?? [])];
    const idx = ourIndex(list);
    if (idx < 0) {
      list.push(handler);
      touched.push(event);
    } else {
      if (JSON.stringify(list[idx]) !== JSON.stringify(handler)) {
        list[idx] = handler;
        touched.push(event);
      }
      for (let i = list.length - 1; i >= 0; i--) {
        if (i !== idx && isOurHandler(list[i])) list.splice(i, 1);
      }
    }
    hooks[event] = list;
  }
  if (!touched.length) return { action: 'none', message: tr('já instalado') };
  return {
    action: 'install',
    file: { version: file.version ?? 1, hooks: hooks as Record<string, unknown[]> },
    message: tr('hooks do Habblaud em {0}', [touched.join(', ')]),
    events: touched,
  };
}

export function planUninstall(file: CursorHooksFile): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  let removed = 0;
  for (const event of EVENTS) {
    const list = (hooks[event] as unknown[] | undefined) ?? [];
    const next = list.filter((h) => !isOurHandler(h));
    removed += list.length - next.length;
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  if (!removed) return { action: 'none', message: tr('não estava instalado') };
  const out: CursorHooksFile = { version: file.version ?? 1 };
  if (Object.keys(hooks).length) out.hooks = hooks as Record<string, unknown[]>;
  return { action: 'uninstall', file: out, message: tr('hooks do Habblaud removidos') };
}

export function cursorHooksPath(home: string): string {
  return join(home, '.cursor', 'hooks.json');
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

export function writeConfig(home: string, port: number, timeoutS: number, autoAllow = false): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true, mode: 0o700 });
  const body: Record<string, unknown> = { port, permissionTimeoutS: timeoutS };
  if (autoAllow) body.autoAllow = true;
  writeFileSync(configPath(home), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

function readHooks(path: string): CursorHooksFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CursorHooksFile;
  } catch {
    return { version: 1, hooks: {} };
  }
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${path}.habblaud-backup-${stamp}`, readFileSync(path), { mode: 0o600 });
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('-h') || argv.includes('--help')) return { help: true as const };
  const port = Number.parseInt(arg('port') ?? env.HABBLAUD_PORT ?? '', 10);
  const timeout = Number(arg('timeout') ?? env.HABBLAUD_PERMISSION_TIMEOUT ?? '');
  return {
    dryRun: argv.includes('--dry-run'),
    autoAllow: argv.includes('--auto-allow'),
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutS: Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout)) : DEFAULT_TIMEOUT_S,
    nodeBin: arg('node'),
  };
}

async function health(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const j = (await res.json()) as { permissions?: boolean };
    return j.permissions === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const opts = parseArgs(process.argv.slice(3));
  if (opts && 'help' in opts) {
    console.log(USAGE);
    process.exit(0);
  }
  const home = process.env.HOME || homedir();
  const hooksPath = cursorHooksPath(home);
  const command = hookCommand(HOOK_SCRIPT, opts.nodeBin ?? process.execPath);
  const say = (line: string) => console.log(`[cursor-hooks] ${line}`);

  if (cmd === 'status') {
    const file = readHooks(hooksPath);
    const hooks = rec(file.hooks) ?? {};
    const installed = EVENTS.filter((e) => ((hooks[e] as unknown[] | undefined) ?? []).some(isOurHandler));
    if (!installed.length) {
      say(tr('Hooks do Habblaud não instalados. Rode: npm run cursor:hooks:install'));
      process.exit(1);
    }
    say(tr('Instalados em ~/.cursor/hooks.json: {0}', [installed.join(', ')]));
    const ok = await health(opts.port);
    say(ok ? tr('Habblaud em http://127.0.0.1:{0}: respondendo pedidos de permissão (com alguma página aberta).', [opts.port]) : tr('Habblaud em http://127.0.0.1:{0}: fora do ar ou permissões desligadas.', [opts.port]));
    return;
  }

  if (cmd !== 'install' && cmd !== 'uninstall') {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }

  const file = readHooks(hooksPath);
  const plan = cmd === 'install' ? planInstall(file, command, opts.timeoutS) : planUninstall(file);
  say(plan.message);
  if (plan.action === 'skip' || plan.action === 'none') process.exit(plan.action === 'skip' ? 1 : 0);
  if (opts.dryRun) {
    say(tr('(dry-run) não gravou nada'));
    process.exit(0);
  }
  mkdirSync(dirname(hooksPath), { recursive: true, mode: 0o755 });
  backup(hooksPath);
  writeFileSync(hooksPath, `${JSON.stringify(plan.file, null, 2)}\n`, { mode: 0o600 });
  if (cmd === 'install') {
    writeConfig(home, opts.port, opts.timeoutS, opts.autoAllow);
    say(
      tr('Configuração em ~/.habblaud/{0} (porta {1}, espera {2} s{3}).', [
        CONFIG_NAME,
        opts.port,
        opts.timeoutS,
        opts.autoAllow ? tr(', autoAllow: sempre aprovar') : '',
      ]),
    );
    say(tr('Abra o Cursor e aprove os hooks na aba Hooks (ou reinicie o IDE).'));
    say(tr('Com o Habblaud aberto no navegador, os pedidos aparecem no escritório como no Claude Code.'));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => process.exit(1));
}
