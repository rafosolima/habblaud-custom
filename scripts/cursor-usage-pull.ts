// Atualiza ~/.habblaud/usage/.cursor.json com Included/Auto/API (mesma API do `/usage` do cursor-agent).
// Rode no host (npm run cursor:usage:pull); com Docker, monte HABBLAUD_USAGE_DIR como no Claude Code.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pullCursorUsageToFile, readCursorAccessToken } from '../server/accounts/cursor-usage';
import { tr } from '../shared/i18n';

const USAGE = tr(
  'Uso: npm run cursor:usage:pull [-- opções]\n\nGrava o uso do plano Cursor (Included/Auto/API) em ~/.habblaud/usage/.cursor.json.\n\nOpções:\n  -h, --help   ajuda\n\nPrecisa estar logado no Cursor CLI (`cursor-agent login`).',
);

function usageDir(env: NodeJS.ProcessEnv, home: string): string {
  const d = (env.HABBLAUD_USAGE_DIR ?? '').trim();
  return d ? resolve(d.replace(/^~(?=\/|$)/, home)) : join(home, '.habblaud', 'usage');
}

async function main(): Promise<void> {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const home = envHome();
  if (!readCursorAccessToken(home)) {
    console.error(tr('Não achei sessão do Cursor CLI ({0}). Rode `cursor-agent login`.', [join(home, '.config/cursor/auth.json')]));
    process.exitCode = 2;
    return;
  }
  try {
    const u = await pullCursorUsageToFile(usageDir(process.env, home), home);
    if (!u) {
      console.error(tr('A API do Cursor não devolveu percentuais de uso.'));
      process.exitCode = 1;
      return;
    }
    const inc = u.sevenDay?.utilization;
    const auto = u.fiveHour?.utilization;
    console.log(tr('Cursor: Included {0}%, Auto {1}% (gravado em {2}).', [inc ?? '—', auto ?? '—', join(usageDir(process.env, home), '.cursor.json')]));
  } catch (err) {
    console.error(tr('[cursor:usage:pull] {0}', [String(err)]));
    process.exitCode = 1;
  }
}

function envHome(): string {
  return process.env.HOME || homedir();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
