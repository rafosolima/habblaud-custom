// Pastas do Gemini CLI: GEMINI_HOME/tmp/<projectHash>/chats/session-*.jsonl (e legado session-*.json).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const GEMINI_RECENT_MS = 30 * 60_000;
export const GEMINI_WORKING_MS = 90_000;

const SESSION_PREFIX = 'session-';

export interface GeminiSessionRef {
  sessionId: string;
  projectHash: string;
  path: string;
  mtimeMs: number;
  /** Primeira pasta do workspace (metadata directories[0]). */
  cwd?: string;
  kind?: 'main' | 'subagent';
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Lê só a primeira linha útil do jsonl (metadata). */
export function readSessionHead(path: string): Pick<GeminiSessionRef, 'sessionId' | 'cwd' | 'kind'> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 65_536);
  } catch {
    return undefined;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: Record<string, unknown> | undefined;
    try {
      o = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (!o) continue;
    const set = rec(o.$set);
    if (set) {
      const sid = str(set.sessionId);
      const dirs = set.directories;
      const cwd = Array.isArray(dirs) && typeof dirs[0] === 'string' ? dirs[0].trim() : undefined;
      const kind = set.kind === 'subagent' ? 'subagent' : undefined;
      if (sid) return { sessionId: sid, cwd, kind };
      continue;
    }
    if (o.type === 'session_metadata' || (str(o.sessionId) && str(o.projectHash))) {
      const sid = str(o.sessionId);
      if (!sid) continue;
      const dirs = o.directories;
      const cwd = Array.isArray(dirs) && typeof dirs[0] === 'string' ? dirs[0].trim() : undefined;
      const kind = o.kind === 'subagent' ? 'subagent' : undefined;
      return { sessionId: sid, cwd, kind };
    }
  }
  return undefined;
}

/** Sessões de chat em tmp/<hash>/chats/. */
export function listGeminiSessions(geminiHome: string): GeminiSessionRef[] {
  const tmp = join(geminiHome, 'tmp');
  if (!isDir(tmp)) return [];
  const out: GeminiSessionRef[] = [];
  for (const projectHash of listDir(tmp)) {
    const chats = join(tmp, projectHash, 'chats');
    if (!isDir(chats)) continue;
    for (const name of listDir(chats)) {
      if (!name.startsWith(SESSION_PREFIX)) continue;
      if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue;
      const path = resolve(join(chats, name));
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const head = readSessionHead(path);
      const sessionId = head?.sessionId ?? name.slice(SESSION_PREFIX.length).replace(/\.jsonl?$/, '').split('-').pop() ?? name;
      out.push({
        sessionId,
        projectHash,
        path,
        mtimeMs,
        cwd: head?.cwd,
        kind: head?.kind,
      });
    }
  }
  return out;
}

export function isGeminiPresent(mtimeMs: number, now: number, recentMs: number = GEMINI_RECENT_MS): boolean {
  return now - mtimeMs <= recentMs;
}

export function isGeminiWorking(mtimeMs: number, now: number, workingMs: number = GEMINI_WORKING_MS): boolean {
  return now - mtimeMs <= workingMs;
}
