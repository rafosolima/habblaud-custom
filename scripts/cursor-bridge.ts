// Auxiliar do Habblaud para mensagens ao Cursor quando o Habblaud roda no Docker (ou sem o binário no servidor).
// Roda no host: npm run cursor:bridge
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { pullCursorUsageToFile } from '../server/accounts/cursor-usage';
import { CHAT_ID, createCursorAgentRunner, findCursorBin, type CursorAgentRunner } from '../server/messages/cursor';
import { tr } from '../shared/i18n';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_PORT = 4747;
export const POLL_MS = 2_000;
export const USAGE_PULL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

const USAGE = tr(
  'Uso: npm run cursor:bridge [-- opções]\n\nEntrega mensagens do escritório aos agentes do Cursor (IDE / cursor-agent).\n\nOpções:\n  --port <n>   porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --once       uma rodada só\n  -h, --help   ajuda\n\nBinário: HABBLAUD_CURSOR_BIN ou `agent` no PATH.',
  [DEFAULT_PORT],
);

export interface BridgeMessage {
  id: string;
  chatId: string;
  cwd: string;
  text: string;
}

export interface BridgeResult {
  id: string;
  ok: boolean;
  error?: string;
}

type Rec = Record<string, unknown>;
function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function checkMessage(raw: unknown): BridgeMessage | { id?: string; error: string } {
  const r = rec(raw);
  const id = typeof r?.id === 'string' && r.id.trim() ? r.id : undefined;
  if (!r || !id) return { error: tr('mensagem sem id') };
  if (typeof r.text !== 'string' || !r.text.trim()) return { id, error: tr('mensagem vazia') };
  if (typeof r.chatId !== 'string' || !CHAT_ID.test(r.chatId)) return { id, error: tr('id de chat do Cursor inválido') };
  const cwd = typeof r.cwd === 'string' ? r.cwd : '';
  if (!cwd || !isAbsolute(cwd) || !isDir(cwd)) return { id, error: tr('a pasta do projeto {0} não existe neste computador', [cwd || tr('(vazia)')]) };
  return { id, chatId: r.chatId, cwd: resolve(cwd), text: r.text };
}

export type Post = (path: string, body: unknown) => Promise<{ status: number; json: unknown } | null>;

export function httpPost(port: number, timeoutMs = REQUEST_TIMEOUT_MS): Post {
  return async (path, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  };
}

export type RoundResult =
  | { state: 'down' }
  | { state: 'refused'; status: number; error?: string }
  | { state: 'ok'; results: BridgeResult[] };

export async function round(post: Post, run: CursorAgentRunner, log: (line: string) => void = () => {}): Promise<RoundResult> {
  const polled = await post('/api/cursor/bridge/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.messages;
  if (polled.status !== 200 || !Array.isArray(list)) {
    const error = rec(polled.json)?.error;
    return { state: 'refused', status: polled.status, ...(typeof error === 'string' ? { error } : {}) };
  }
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const m = checkMessage(raw);
    if ('error' in m) {
      if (m.id) {
        const result = { id: m.id, ok: false, error: m.error };
        results.push(result);
        await post('/api/cursor/bridge/ack', { results: [result] });
      }
      log(tr('✗ mensagem recusada: {0}', [m.error]));
      continue;
    }
    let r;
    try {
      r = await run({ chatId: m.chatId, cwd: m.cwd, text: m.text });
    } catch (err) {
      r = { ok: false as const, error: String(err) };
    }
    const result = r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error };
    results.push(result);
    await post('/api/cursor/bridge/ack', { results: [result] });
    log(r.ok ? tr('✓ mensagem enviada ao chat {0}…', [m.chatId.slice(0, 8)]) : `✗ ${m.chatId.slice(0, 8)}…: ${r.error}`);
  }
  return { state: 'ok', results };
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { port: number; once: boolean } | 'help' {
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--once') once = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  return { port, once };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof FatalError ? err.message : err);
    process.exitCode = 2;
    return;
  }
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const bin = findCursorBin(process.env);
  if (!bin) {
    console.error(tr('Não achei o Cursor CLI (`agent` ou `cursor-agent` no PATH, ou HABBLAUD_CURSOR_BIN).'));
    process.exitCode = 2;
    return;
  }
  const run = createCursorAgentRunner(bin);
  const post = httpPost(parsed.port);
  const home = process.env.HOME || homedir();
  const usageDir = (() => {
    const d = (process.env.HABBLAUD_USAGE_DIR ?? '').trim();
    return d ? resolve(d.replace(/^~(?=\/|$)/, home)) : join(home, '.habblaud', 'usage');
  })();
  let lastUsagePull = 0;
  const maybePullUsage = async () => {
    const now = Date.now();
    if (now - lastUsagePull < USAGE_PULL_MS) return;
    lastUsagePull = now;
    try {
      await pullCursorUsageToFile(usageDir, home);
    } catch {
      // silencioso: mensagens têm prioridade
    }
  };
  console.log(tr('Cursor bridge: Habblaud em http://127.0.0.1:{0}, binário {1}. Ctrl+C para parar.', [String(parsed.port), bin]));
  for (;;) {
    await maybePullUsage();
    const r = await round(post, run, (line) => console.log(line));
    if (r.state === 'down') process.stderr.write(tr('Habblaud não respondeu; tentando de novo…\n'));
    if (parsed.once) {
      process.exitCode = r.state === 'ok' && r.results.every((x) => x.ok) ? 0 : 1;
      return;
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? err.message : String(err));
    process.exitCode = 1;
  });
}
