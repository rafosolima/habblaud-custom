#!/usr/bin/env node
// Hook do Habblaud para o Cursor IDE: deixa aprovar ou recusar pelo escritório antes de rodar ferramentas
// (preToolUse, beforeShellExecution, beforeMCPExecution). `npm run cursor:hooks:install` acrescenta em
// ~/.cursor/hooks.json um handler que roda:
//
//   node "<Habblaud>/mod/habblaud-cursor-permissoes/hook.mjs"
//
// Porta e tempo limite ficam em ~/.habblaud/cursor-hook.json ({port, permissionTimeoutS, autoAllow}); HABBLAUD_PORT e
// HABBLAUD_CURSOR_AUTO_ALLOW=1 também valem. Com autoAllow, o hook só imprime {"permission":"allow"} (sem esperar o escritório).
//
// O hook:
// 1. lê do stdin o JSON do evento (conversation_id, hook_event_name, comando ou ferramenta...);
// 2. manda para POST http://127.0.0.1:<porta>/api/permissions (provider "cursor", session_id = conversation_id);
// 3. espera a decisão em GET /api/permissions/:id/wait até o tempo limite;
// 4. aprovado: imprime {"permission":"allow"}; recusado: {"permission":"deny", ...}. Sem decisão: sai sem imprimir
//    (o Cursor segue com a aprovação normal do IDE).
//
// Regras: Node puro (22+), só `node:*`, sem dependências; nunca trava a sessão (todo erro = sair com 0 e sem saída).
// Só fala com 127.0.0.1. HABBLAUD_HOOK_DEBUG=1 escreve no stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
export const MIN_TIMEOUT_S = 5;
export const MAX_TIMEOUT_S = 86_400;
export const CONFIG_FILE = 'cursor-hook.json';
const POLL_S = 25;
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 8_000;
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-cursor-perm] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Eventos que pedem aprovação no Habblaud antes de continuar. */
export const GATED = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution']);

export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const wait = Number(f.permissionTimeoutS);
  const autoAllow =
    f.autoAllow === true ||
    env.HABBLAUD_CURSOR_AUTO_ALLOW === '1' ||
    /^(1|true|yes|on)$/i.test(String(env.HABBLAUD_CURSOR_AUTO_ALLOW ?? ''));
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    timeoutMs: (Number.isFinite(wait) && wait > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, wait)) : DEFAULT_TIMEOUT_S) * 1_000,
    autoAllow,
  };
}

export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/** Nome da ferramenta e argumentos a partir do stdin do Cursor. */
export function toolFromEvent(input) {
  const event = input.hook_event_name;
  if (event === 'beforeShellExecution') {
    const command = typeof input.command === 'string' ? input.command : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
    return { tool: 'Shell', input: { command, ...(cwd ? { cwd } : {}), description: command.slice(0, 200) } };
  }
  if (event === 'beforeMCPExecution') {
    const tool = typeof input.tool_name === 'string' ? input.tool_name : typeof input.toolName === 'string' ? input.toolName : 'MCP';
    const raw = isObject(input.tool_input) ? input.tool_input : isObject(input.arguments) ? input.arguments : {};
    return { tool, input: raw };
  }
  if (event === 'preToolUse') {
    const tool = typeof input.tool_name === 'string' ? input.tool_name : typeof input.toolName === 'string' ? input.toolName : 'Tool';
    const raw = isObject(input.tool_input)
      ? input.tool_input
      : isObject(input.input)
        ? input.input
        : isObject(input.arguments)
          ? input.arguments
          : {};
    return { tool, input: raw };
  }
  return undefined;
}

/** Corpo de POST /api/permissions para agentes Cursor no escritório. */
export function permissionBody(input, timeoutMs) {
  const parsed = toolFromEvent(input);
  if (!parsed) return undefined;
  const chatId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
  if (!chatId) return undefined;
  const cwd =
    (typeof input.cwd === 'string' && input.cwd.trim()) ||
    (Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === 'string' ? input.workspace_roots[0] : undefined);
  const body = {
    provider: 'cursor',
    session_id: chatId,
    tool_name: parsed.tool,
    tool_input: {},
    timeout_ms: timeoutMs,
    cursor_event: input.hook_event_name,
  };
  if (cwd) body.cwd = cwd;
  body.tool_input = fitted(parsed.input, (toolInput) => JSON.stringify({ ...body, tool_input: toolInput }).length);
  return body;
}

/** Saída JSON do hook Cursor (undefined = não decidir; o IDE segue). */
export function cursorOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return { permission: 'allow' };
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const msg = reason ? `Recusado no Habblaud: ${reason}` : 'Recusado no Habblaud.';
    return { permission: 'deny', user_message: msg, agent_message: msg };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Registra o pedido e espera a decisão. Devolve o objeto de saída ou undefined. Nunca lança. */
export async function run(env = process.env, stdinText) {
  const startedAt = Date.now();
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isObject(input) || typeof input.hook_event_name !== 'string' || !GATED.has(input.hook_event_name)) return undefined;
    const cfg = readConfig(env);
    if (cfg.autoAllow) {
      debug('autoAllow: allow');
      return { permission: 'allow' };
    }
    const body = permissionBody(input, cfg.timeoutMs);
    if (!body) return undefined;
    const base = `http://127.0.0.1:${cfg.port}`;
    const deadline = startedAt + cfg.timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', body, REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud fora do ar'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: vale o IDE');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      if (r.json?.status === 'pending') continue;
      debug(`resposta: ${JSON.stringify(r.json)}`);
      return cursorOutput(r.json);
    }
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const { timeoutMs } = readConfig();
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
