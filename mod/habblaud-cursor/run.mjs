#!/usr/bin/env node
// Wrapper do Habblaud para o Cursor CLI (`cursor-agent`): roda um pedido do Cursor como um "desenvolvedor" que aparece
// no escritório, com nome e papel, ligado à sessão do Claude Code que o chamou. Instalado por `npm run cursor:install`
// em ~/.habblaud/bin/habblaud-cursor. Uso:
//
//   habblaud-cursor --name "Lucas" --role "Dev - Mestre" [--dir <pasta>] [--raw] -- <pedido ou opções do cursor-agent>
//
// O que faz:
// 1. roda `cursor-agent -p --output-format stream-json --stream-partial-output <o resto>` na pasta (--dir, ou a atual);
//    HABBLAUD_CURSOR_BIN troca o executável;
// 2. grava o stream em <HABBLAUD_CURSOR_DIR ou ~/.habblaud/cursor>/sessions/<execução>.jsonl (pasta 700, arquivo 600):
//    1ª linha `habblaud_meta` (pid, quem chamou: CLAUDE_CODE_SESSION_ID/CLAUDE_PID, nome, papel, pasta, início), depois
//    as linhas do Cursor e, no fim, `habblaud_end` com o código de saída. Para o arquivo ficar pequeno e sem segredos:
//    os pedaços seguidos de texto e de raciocínio viram uma linha só, o `env` (ambiente inteiro do shell) sai, e o
//    conteúdo completo de arquivos e textos enormes são cortados. Arquivos com mais de 7 dias são apagados;
// 3. imprime para quem chamou um resultado curto (a resposta final e uma linha com as ferramentas usadas), em vez do
//    stream; `--raw` repassa o stream como veio. O código de saída é o do cursor-agent; SIGINT/SIGTERM são repassados;
// 4. termina SEMPRE com a linha `chatId: <session_id>` (no stdout; com --raw, no stderr, para não misturar com o
//    JSON): é o id que `--resume <chatId>` aceita, para mandar uma correção ao mesmo dev mantendo o contexto. Uma
//    execução com `--resume <chatId>` grava um arquivo NOVO (com `resume` no meta) e aparece no escritório como o MESMO
//    personagem (o agente é `cursor:<chatId>`).
//
// Node puro (22+), só `node:*`, sem dependências. O nome é obrigatório: é ele que vira o personagem ("Lucas (Dev -
// Mestre)"); o mesmo nome rodando duas vezes ao mesmo tempo aparece como "Lucas 2 (Dev - Mestre)".
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const KEEP_DAYS = 7;
/** Textos maiores que isto são cortados no arquivo (o escritório só mostra prévias). */
export const MAX_STRING = 16_000;
/** Campos que nunca vão para o arquivo: o ambiente do shell e o conteúdo inteiro dos arquivos editados. */
const DROP_KEYS = new Set(['env', 'beforeFullFileContent', 'afterFullFileContent', 'fileBytes']);

const USAGE = `Uso: habblaud-cursor --name <nome> --role <papel> [--dir <pasta>] [--raw] -- <pedido ou opções do cursor-agent>

  --name   nome do personagem no Habblaud (ex.: Lucas)
  --role   papel (ex.: "Dev - Mestre"); o personagem aparece como "Lucas (Dev - Mestre)"
  --dir    pasta onde o cursor-agent roda (padrão: a atual)
  --raw    repassa o stream-json do Cursor em vez do resumo

Exemplo: habblaud-cursor --name Lucas --role "Dev - Mestre" --dir ~/proj -- "Implemente o endpoint X e rode os testes"

No fim sai a linha "chatId: <id>". Para mandar uma correção ao mesmo dev, com o contexto:
  habblaud-cursor --name Lucas --role "Dev - Mestre" --dir ~/proj -- --resume <id> "Corrija o teste que falhou"`;

/** O `--resume <chatId>` (ou `--resume=<chatId>`) passado ao cursor-agent, se houver. */
export function resumeOf(rest) {
  for (let i = 0; i < rest.length; i++) {
    const m = /^--resume=(.+)$/.exec(rest[i]);
    if (m) return m[1].trim() || undefined;
    if (rest[i] === '--resume' && rest[i + 1] && !rest[i + 1].startsWith('-')) return rest[i + 1].trim() || undefined;
  }
  return undefined;
}

/** Opções do wrapper e o resto (que vai para o cursor-agent). */
export function parseArgs(argv) {
  const out = { name: undefined, role: undefined, dir: undefined, raw: false, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest.push(...argv.slice(i + 1));
      break;
    }
    const eq = /^--(name|role|dir)=(.*)$/.exec(a);
    if (eq) out[eq[1]] = eq[2];
    else if (a === '--name' || a === '--role' || a === '--dir') out[a.slice(2)] = argv[++i];
    else if (a === '--raw') out.raw = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out.rest.push(a);
  }
  for (const k of ['name', 'role', 'dir']) if (typeof out[k] === 'string') out[k] = out[k].trim() || undefined;
  return out;
}

/** Executável do Cursor CLI: HABBLAUD_CURSOR_BIN, senão `cursor-agent` ou `agent` no PATH. */
export function resolveCursorAgentBin(env = process.env) {
  const explicit = env.HABBLAUD_CURSOR_BIN?.trim();
  if (explicit) return explicit;
  for (const name of ['cursor-agent', 'agent']) {
    try {
      const out = execFileSync('which', [name], { encoding: 'utf8', env: { PATH: env.PATH ?? '', ...env } }).trim();
      if (out) return out;
    } catch {
      // tenta o próximo nome
    }
  }
  return 'cursor-agent';
}

/** O ambiente do cursor-agent: o da sessão que chamou, menos o canal de mensagens dela (token e socket do Claude
 * Code), que os comandos do dev não têm por que ver. */
export function childEnv(env) {
  const out = { ...env };
  delete out.CLAUDE_CODE_MESSAGING_TOKEN;
  delete out.CLAUDE_CODE_MESSAGING_SOCKET;
  return out;
}

export function sessionsDir(env = process.env) {
  const base = env.HABBLAUD_CURSOR_DIR?.trim() || join(env.HOME || homedir(), '.habblaud', 'cursor');
  return join(resolve(base), 'sessions');
}

/** Apaga as execuções com mais de KEEP_DAYS dias (só *.jsonl desta pasta). */
export function prune(dir, now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    try {
      if (now - statSync(join(dir, n)).mtimeMs > KEEP_DAYS * 86_400_000) unlinkSync(join(dir, n));
    } catch {
      // sumiu ou sem permissão
    }
  }
}

/** Cópia sem os campos proibidos e com os textos enormes cortados. */
export function sanitize(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (!v || typeof v !== 'object' || depth > 40) return v;
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.has(k)) out[k] = sanitize(x, depth + 1);
  return out;
}

function textOf(o) {
  const c = o?.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((x) => (x && x.type === 'text' && typeof x.text === 'string' ? x.text : '')).join('') : '';
}

function toolKey(o) {
  const tc = o?.tool_call;
  if (!tc || typeof tc !== 'object') return undefined;
  return Object.keys(tc).find((k) => /ToolCall$/.test(k));
}

/**
 * Junta os pedaços do stream (texto e raciocínio) e guarda o que o resumo precisa. `write(obj)` grava uma linha no
 * arquivo. Devolve {push(line), flush(), summary()}.
 */
export function createRecorder(write) {
  let pending; // {kind: 'assistant'|'thinking', obj, text, parts}
  const tools = new Map();
  let result;
  let lastText = '';
  let sessionId;

  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = undefined;
    if (p.kind === 'assistant') {
      lastText = p.text;
      write({ ...p.obj, message: { role: 'assistant', content: [{ type: 'text', text: p.text }] } });
    } else write({ ...p.obj, subtype: 'delta', text: p.text });
  };

  const push = (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      flush();
      write({ type: 'habblaud_text', text: line.slice(0, MAX_STRING) });
      return;
    }
    if (!o || typeof o !== 'object') return;
    if (typeof o.session_id === 'string') sessionId ??= o.session_id;
    if (o.type === 'assistant') {
      const text = textOf(o);
      if (pending?.kind === 'assistant') {
        // A linha com o texto inteiro que o Cursor manda depois dos pedaços: já está no acumulado.
        if (text === pending.text) return;
        pending.text += text;
        pending.parts++;
        return;
      }
      flush();
      pending = { kind: 'assistant', obj: sanitize(o), text, parts: 1 };
      return;
    }
    if (o.type === 'thinking' && o.subtype === 'delta') {
      if (pending?.kind === 'thinking') {
        pending.text += typeof o.text === 'string' ? o.text : '';
        return;
      }
      flush();
      pending = { kind: 'thinking', obj: sanitize(o), text: typeof o.text === 'string' ? o.text : '', parts: 1 };
      return;
    }
    flush();
    if (o.type === 'tool_call' && o.subtype === 'started') {
      const k = toolKey(o);
      if (k) {
        const name = k.replace(/ToolCall$/, '');
        tools.set(name, (tools.get(name) ?? 0) + 1);
      }
    }
    if (o.type === 'result') result = { text: typeof o.result === 'string' ? o.result : '', error: o.is_error === true, ms: o.duration_ms };
    write(sanitize(o));
  };

  const summary = () => ({ result, lastText, tools, sessionId });
  return { push, flush, summary };
}

/** Texto curto para quem chamou: a resposta e uma linha com o resumo da execução. */
export function formatSummary(s, info) {
  const lines = [];
  const answer = (s.result?.text || s.lastText || '').trim();
  if (answer) lines.push(answer, '');
  const tools = [...s.tools].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}× ${n}`);
  const parts = [`Cursor · ${info.label}`];
  if (s.result?.ms) parts.push(`${Math.round(s.result.ms / 1000)}s`);
  parts.push(tools.length ? `ferramentas: ${tools.join(', ')}` : 'sem ferramentas');
  if (s.sessionId) parts.push(`sessão ${s.sessionId}`);
  if (info.exitCode) parts.push(`código de saída ${info.exitCode}`);
  if (s.result?.error) parts.push('terminou com erro');
  parts.push(`conversa: ${info.file}`);
  lines.push(`[${parts.join(' · ')}]`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!args.name || !args.role) {
    process.stderr.write(`habblaud-cursor: --name e --role são obrigatórios.\n\n${USAGE}\n`);
    return 2;
  }
  if (!args.rest.length) {
    process.stderr.write(`habblaud-cursor: falta o pedido (depois de --).\n\n${USAGE}\n`);
    return 2;
  }
  const cwd = resolve(args.dir ?? process.cwd());
  const dir = sessionsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // pasta de outro dono: segue
  }
  prune(dir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const run = `${stamp}-${randomBytes(4).toString('hex')}`;
  const file = join(dir, `${run}.jsonl`);
  const fd = openSync(file, 'a', 0o600);
  const write = (o) => {
    try {
      writeSync(fd, `${JSON.stringify(o)}\n`);
    } catch {
      // disco cheio: o cursor-agent continua
    }
  };
  const bin = resolveCursorAgentBin(env);
  const cursorArgs = ['-p', '--output-format', 'stream-json', '--stream-partial-output', ...args.rest];
  let child;
  let spawnError;
  try {
    child = spawn(bin, cursorArgs, { cwd, env: childEnv(env), stdio: ['inherit', 'pipe', 'inherit'] });
  } catch (err) {
    spawnError = err;
  }
  const meta = {
    type: 'habblaud_meta',
    v: 1,
    pid: child?.pid ?? null,
    wrapperPid: process.pid,
    parentSessionId: env.CLAUDE_CODE_SESSION_ID || null,
    parentPid: env.CLAUDE_PID ? Number(env.CLAUDE_PID) || null : null,
    name: args.name,
    role: args.role,
    cwd,
    startedAt: new Date().toISOString(),
    ...(resumeOf(args.rest) ? { resume: resumeOf(args.rest) } : {}),
  };
  write(meta);
  const label = `${args.name} (${args.role})`;
  const rec = createRecorder(write);

  const exitCode = await new Promise((done) => {
    if (!child) return done({ code: 127, error: spawnError });
    child.on('error', (err) => done({ code: 127, error: err }));
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        // já saiu
      }
    };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (args.raw) process.stdout.write(`${line}\n`);
      if (line.trim()) rec.push(line);
    });
    let closed = false;
    let exit;
    const finish = () => {
      if (!closed || !exit) return;
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      done(exit);
    };
    rl.on('close', () => {
      closed = true;
      finish();
    });
    child.on('close', (code, signal) => {
      exit = { code: code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1), signal };
      closed = true;
      finish();
    });
  });

  rec.flush();
  write({ type: 'habblaud_end', exitCode: exitCode.code, ...(exitCode.signal ? { signal: exitCode.signal } : {}), at: new Date().toISOString() });
  closeSync(fd);
  if (exitCode.error) {
    process.stderr.write(`habblaud-cursor: não foi possível rodar ${bin} (${exitCode.error.code ?? exitCode.error.message}). Instale o Cursor CLI ou defina HABBLAUD_CURSOR_BIN.\n`);
  } else if (!args.raw) {
    process.stdout.write(`${formatSummary(rec.summary(), { label, file, exitCode: exitCode.code })}\n`);
  }
  // O id da conversa (para o --resume): o session_id do init; sem ele (falhou antes), o --resume pedido.
  const chatId = rec.summary().sessionId ?? meta.resume;
  if (chatId) (args.raw ? process.stderr : process.stdout).write(`chatId: ${chatId}\n`);
  return exitCode.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`habblaud-cursor: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
