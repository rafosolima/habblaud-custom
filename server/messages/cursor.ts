// Mensagens pelo escritório para sessões do Cursor (IDE ou cursor-agent): `agent -p --resume <chatId>` com o pedido.
// O comando roda no host (pasta roomId do agente). Modo Node: o servidor dispara e não espera o turno terminar; no
// Docker: o auxiliar (scripts/cursor-bridge.ts, npm run cursor:bridge) busca em POST /api/cursor/bridge/poll.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { tr } from '../../shared/i18n';

export const SUBMIT_TIMEOUT_MS = 15_000;
/** Id de chat do Cursor (UUID; sessionId do agente principal). */
export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CURSOR_BIN_NAME = process.platform === 'win32' ? 'agent.exe' : 'agent';

export interface CursorAgentJob {
  chatId: string;
  /** Pasta do projeto (AgentInfo.roomId). */
  cwd: string;
  text: string;
}

export type CursorAgentResult = { ok: true } | { ok: false; error: string };
export type CursorAgentRunner = (job: CursorAgentJob) => Promise<CursorAgentResult>;

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Binário: HABBLAUD_CURSOR_BIN ou `agent`/`cursor-agent` no PATH. */
export function findCursorBin(env: NodeJS.ProcessEnv, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_CURSOR_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const name of [CURSOR_BIN_NAME, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent']) {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const p = `${dir.replace(/\/$/, '')}/${name}`;
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

/** Argumentos: retoma o chat e manda o texto como prompt (não espera o turno acabar). */
export function resumeArgs(chatId: string, text: string): string[] {
  return ['-p', '--resume', chatId, '--force', text];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Dispara o agent; sucesso = processo iniciou (a resposta continua no Cursor). */
export function createCursorAgentRunner(bin: string, opts: { env?: NodeJS.ProcessEnv } = {}): CursorAgentRunner {
  return (job) =>
    new Promise((done) => {
      if (!CHAT_ID.test(job.chatId)) return done({ ok: false, error: tr('id de chat do Cursor inválido') });
      if (!isAbsolute(job.cwd) || !isDir(job.cwd)) return done({ ok: false, error: tr('pasta do projeto deste agente é inválida') });
      const env = opts.env ?? process.env;
      let child;
      try {
        child = spawn(bin, resumeArgs(job.chatId, job.text), { cwd: job.cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
      } catch {
        return done({ ok: false, error: tr('não consegui rodar o Cursor ({0})', [bin]) });
      }
      child.unref?.();
      const timer = setTimeout(() => done({ ok: true }), 500);
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, error: tr('não consegui rodar o Cursor ({0})', [err.message]) });
      });
      child.on('spawn', () => {
        clearTimeout(timer);
        done({ ok: true });
      });
    });
}
