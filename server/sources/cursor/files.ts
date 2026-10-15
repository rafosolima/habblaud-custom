// Pastas do Cursor: ~/.cursor/chats (presença) e ~/.cursor/projects/.../agent-transcripts (transcript ao vivo).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expandHome } from '../../accounts/detect';

export const CURSOR_RECENT_MS = 30 * 60_000;
/** Janela quente para status `working` (ainda presente, mas parado = `idle`). */
export const CURSOR_WORKING_MS = 5 * 60_000;

export interface CursorChatMeta {
  chatId: string;
  /** Caminho absoluto da pasta do chat (meta.json / store.db). */
  dir: string;
  title?: string;
  cwd?: string;
  updatedAtMs: number;
  isSubagent: boolean;
  storeMtimeMs?: number;
}

const CHATS = 'chats';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasChatsDir(root: string): boolean {
  return isDir(join(root, CHATS));
}

function chatOverridePaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const raw = splitList(env.HABBLAUD_CURSOR_CHATS_DIRS);
  const list = raw.length ? raw : splitList(env.HABBLAUD_CURSOR_CHATS_DIR);
  return [...new Set(list.map((p) => expandHome(p, home)))];
}

/** Raízes com subpasta `chats/` (em geral ~/.cursor). HABBLAUD_CURSOR_CHATS_DIRS substitui a detecção automática. */
export function discoverCursorRoots(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = chatOverridePaths(env, home);
  if (override.length) return override.filter(hasChatsDir);
  const def = join(home, '.cursor');
  return hasChatsDir(def) ? [def] : [];
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMeta(chatDir: string, chatId: string): CursorChatMeta | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(chatDir, 'meta.json'), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rec = parsed as Record<string, unknown>;
  const updatedAtMs = rec.updatedAtMs;
  if (typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)) return undefined;

  const meta: CursorChatMeta = {
    chatId,
    dir: resolve(chatDir),
    updatedAtMs,
    isSubagent: rec.isSubagent === true,
  };
  if (typeof rec.title === 'string' && rec.title.trim()) meta.title = rec.title.trim();
  if (typeof rec.cwd === 'string' && rec.cwd.trim()) meta.cwd = rec.cwd.trim();

  const storePath = join(chatDir, 'store.db');
  try {
    meta.storeMtimeMs = statSync(storePath).mtimeMs;
  } catch {
    // sem store.db
  }
  return meta;
}

/** Metas de todos os chats em root/chats (ignora ilegíveis). */
export function listCursorChats(root: string, _now?: number): CursorChatMeta[] {
  const chatsRoot = join(root, CHATS);
  const out: CursorChatMeta[] = [];
  for (const projectHash of listDir(chatsRoot)) {
    const projectDir = join(chatsRoot, projectHash);
    if (!isDir(projectDir)) continue;
    for (const chatId of listDir(projectDir)) {
      const chatDir = join(projectDir, chatId);
      if (!isDir(chatDir)) continue;
      const meta = readMeta(chatDir, chatId);
      if (meta) out.push(meta);
    }
  }
  return out;
}

function activityMs(meta: CursorChatMeta): number {
  return Math.max(meta.updatedAtMs, meta.storeMtimeMs ?? 0);
}

export function isCursorPresent(meta: CursorChatMeta, now: number, recentMs: number = CURSOR_RECENT_MS): boolean {
  return now - activityMs(meta) <= recentMs;
}

export function isCursorWorking(meta: CursorChatMeta, now: number, workingMs: number = CURSOR_WORKING_MS): boolean {
  return now - activityMs(meta) <= workingMs;
}

const PROJECTS = 'projects';

/** Slug de pasta em ~/.cursor/projects a partir do cwd (como o Cursor grava). */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\//g, '-');
}

function transcriptCandidates(home: string, chatId: string, cwd?: string): string[] {
  const root = join(home, '.cursor', PROJECTS);
  const out: string[] = [];
  if (cwd) out.push(join(root, cwdToProjectSlug(cwd), 'agent-transcripts', chatId, `${chatId}.jsonl`));
  try {
    for (const slug of readdirSync(root)) {
      const p = join(root, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
      if (!out.includes(p)) out.push(p);
    }
  } catch {
    // sem ~/.cursor/projects
  }
  return out;
}

export interface CursorSubagentTranscript {
  subId: string;
  parentChatId: string;
  path: string;
  mtimeMs: number;
  cwd?: string;
}

/** Subagentes do Cursor IDE: `<projeto>/agent-transcripts/<pai>/subagents/<id>.jsonl`. */
export function listSubagentTranscripts(home: string, parentChatId: string, cwd?: string): CursorSubagentTranscript[] {
  const main = resolveAgentTranscript(home, parentChatId, cwd);
  if (!main) return [];
  const subDir = join(main, '..', 'subagents');
  if (!isDir(subDir)) return [];
  const out: CursorSubagentTranscript[] = [];
  for (const name of listDir(subDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const subId = name.slice(0, -'.jsonl'.length);
    const path = resolve(join(subDir, name));
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    out.push({ subId, parentChatId, path, mtimeMs, cwd });
  }
  return out;
}

/** Transcript jsonl ainda “aberto” (sem meta.json: usa só o mtime). */
export function isTranscriptPresent(mtimeMs: number, now: number, recentMs: number = CURSOR_RECENT_MS): boolean {
  return now - mtimeMs <= recentMs;
}

/** Transcript ao vivo do agente no IDE (jsonl por linha). */
export function resolveAgentTranscript(home: string, chatId: string, cwd?: string): string | undefined {
  for (const p of transcriptCandidates(home, chatId, cwd)) {
    try {
      if (statSync(p).isFile()) return resolve(p);
    } catch {
      // próximo
    }
  }
  return undefined;
}

export interface CursorStoreSessionMeta {
  name?: string;
  lastUsedModel?: string;
}

/** Nome e modelo da sessão (meta key 0 em store.db, hex-encoded JSON). */
export function readStoreSessionMeta(chatDir: string): CursorStoreSessionMeta | undefined {
  const dbPath = join(chatDir, 'store.db');
  if (!existsSync(dbPath)) return undefined;
  let row: { value?: string } | undefined;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  const hex = row?.value?.trim();
  if (!hex) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rec = parsed as Record<string, unknown>;
  const out: CursorStoreSessionMeta = {};
  if (typeof rec.name === 'string' && rec.name.trim()) out.name = rec.name.trim().slice(0, 24);
  if (typeof rec.lastUsedModel === 'string' && rec.lastUsedModel.trim()) out.lastUsedModel = rec.lastUsedModel.trim();
  return Object.keys(out).length ? out : undefined;
}
