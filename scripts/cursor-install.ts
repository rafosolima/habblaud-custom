// Instala (ou remove) o wrapper do Cursor CLI no HOST, com tsx:
//
//   npm run cursor:install     # copia mod/habblaud-cursor/run.mjs para ~/.habblaud/bin/ e cria o atalho habblaud-cursor
//   npm run cursor:uninstall   # apaga os dois (as conversas em ~/.habblaud/cursor ficam)
//
// O atalho é um script de shell que roda `node <cópia do run.mjs>`: continua funcionando se o repositório mudar de
// lugar (rode o install de novo para atualizar). Nada da configuração do Cursor é tocado.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WRAPPER_SCRIPT = join(ROOT, 'mod', 'habblaud-cursor', 'run.mjs');
export const SHIM_NAME = 'habblaud-cursor';
export const COPY_NAME = 'habblaud-cursor.mjs';

/** Pasta dos executáveis do Habblaud: ~/.habblaud/bin. */
export function binDir(home: string): string {
  return join(home, '.habblaud', 'bin');
}

/** Texto do atalho: um shell que roda a cópia do wrapper com o node (o mesmo deste install, se estiver à mão). */
export function shimText(copy: string, nodeBin = 'node'): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Atalho do Habblaud para o Cursor CLI (npm run cursor:install). Uso: habblaud-cursor --help\nexec ${q(nodeBin)} ${q(copy)} "$@"\n`;
}

export interface CursorInstallContext {
  home: string;
  /** run.mjs do repositório. */
  source?: string;
  /** node usado no atalho (padrão: o que roda o install). */
  nodeBin?: string;
  out: (line: string) => void;
}

export function install(ctx: CursorInstallContext): number {
  const dir = binDir(ctx.home);
  const copy = join(dir, COPY_NAME);
  const shim = join(dir, SHIM_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  copyFileSync(ctx.source ?? WRAPPER_SCRIPT, copy);
  chmodSync(copy, 0o755);
  writeFileSync(shim, shimText(copy, ctx.nodeBin ?? process.execPath), { mode: 0o755 });
  chmodSync(shim, 0o755);
  ctx.out(tr('Wrapper do Cursor instalado em {0}.', [shim]));
  ctx.out('');
  ctx.out(tr('Para um agente do Claude Code chamar um desenvolvedor do Cursor (o nome e o papel aparecem no escritório):'));
  ctx.out(`  ${shim} --name Lucas --role "Dev - Mestre" --dir <pasta> -- "<pedido>"`);
  ctx.out('');
  ctx.out(tr('O Habblaud lê as conversas em ~/.habblaud/cursor/sessions (HABBLAUD_CURSOR_DIR muda a pasta). O Cursor CLI'));
  ctx.out(tr('precisa estar instalado e logado (cursor-agent no PATH, ou HABBLAUD_CURSOR_BIN).'));
  ctx.out(tr('Para desfazer: npm run cursor:uninstall'));
  return 0;
}

export function uninstall(ctx: CursorInstallContext): number {
  const dir = binDir(ctx.home);
  let removed = 0;
  for (const name of [SHIM_NAME, COPY_NAME]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    rmSync(p, { force: true });
    removed++;
  }
  ctx.out(removed ? tr('Wrapper do Cursor removido de {0} (as conversas em ~/.habblaud/cursor ficam).', [dir]) : tr('Nada a remover: o wrapper do Cursor não está em {0}.', [dir]));
  return 0;
}

function main(): void {
  const cmd = process.argv[2];
  const ctx: CursorInstallContext = { home: process.env.HOME || homedir(), out: (l) => console.log(l) };
  if (cmd === 'install') process.exitCode = install(ctx);
  else if (cmd === 'uninstall') process.exitCode = uninstall(ctx);
  else {
    console.log(tr('Uso: npm run cursor:install | npm run cursor:uninstall'));
    process.exitCode = cmd ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
