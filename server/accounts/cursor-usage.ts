// Uso do plano Cursor (Included / Auto / API): mesma API do `/usage` do cursor-agent, gravado em ~/.habblaud/usage/.cursor.json
// pelo scripts/cursor-usage-pull.ts (host). Só lê o token em ~/.config/cursor/auth.json para buscar; nunca grava credenciais.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountUsage } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const CURSOR_USAGE_ACCOUNT = '.cursor';
export const CURSOR_USAGE_FILE = '.cursor.json';
const API = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const TIMEOUT_MS = 20_000;

export interface CursorUsageFile {
  accountId: string;
  fetchedAt: number;
  billingCycleEndMs?: number;
  includedPercent?: number;
  autoPercent?: number;
  apiPercent?: number;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function pct(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.min(100, Math.max(0, n));
}

function epochMs(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Linux/macOS/Windows: auth.json do Cursor CLI (não confundir com ~/.cursor/cli-config.json). */
export function cursorAuthPath(home: string = homedir()): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'Cursor', 'auth.json');
  }
  if (process.platform === 'darwin') return join(home, '.cursor', 'auth.json');
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(xdg, 'cursor', 'auth.json');
}

export function readCursorAccessToken(home: string = homedir()): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(cursorAuthPath(home), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const t = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).accessToken : undefined;
  return typeof t === 'string' && t.trim() ? t.trim() : undefined;
}

export function parsePeriodUsageBody(body: unknown, fetchedAt: number): { usage: AccountUsage; file: CursorUsageFile } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const r = body as Record<string, unknown>;
  const plan = r.planUsage;
  if (!plan || typeof plan !== 'object') return undefined;
  const p = plan as Record<string, unknown>;
  const included = pct(p.totalPercentUsed);
  const auto = pct(p.autoPercentUsed);
  const api = pct(p.apiPercentUsed);
  if (included === undefined && auto === undefined && api === undefined) return undefined;
  const resetsAt = epochMs(r.billingCycleEnd);
  const usage: AccountUsage = { source: 'cursor', fetchedAt };
  if (auto !== undefined) usage.fiveHour = { utilization: auto, ...(resetsAt ? { resetsAt } : {}) };
  if (included !== undefined) usage.sevenDay = { utilization: included, ...(resetsAt ? { resetsAt } : {}) };
  if (!usage.fiveHour && !usage.sevenDay) return undefined;
  const file: CursorUsageFile = {
    accountId: CURSOR_USAGE_ACCOUNT,
    fetchedAt,
    ...(resetsAt ? { billingCycleEndMs: resetsAt } : {}),
    ...(included !== undefined ? { includedPercent: included } : {}),
    ...(auto !== undefined ? { autoPercent: auto } : {}),
    ...(api !== undefined ? { apiPercent: api } : {}),
  };
  return { usage, file };
}

function fetchCursorPeriodUsageCurl(token: string): unknown {
  const r = spawnSync(
    'curl',
    [
      '-sS',
      '-m',
      String(Math.ceil(TIMEOUT_MS / 1000)),
      '-X',
      'POST',
      API,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'Connect-Protocol-Version: 1',
      '-d',
      '{}',
    ],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(tr('curl falhou ({0})', [String(r.status ?? '?')]));
  const text = (r.stdout ?? '').trim();
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(tr('resposta de uso do Cursor não é JSON'));
  }
}

export async function fetchCursorPeriodUsage(token: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(tr('Cursor API respondeu {0}', [String(res.status)]));
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error(tr('resposta de uso do Cursor não é JSON'));
    }
  } catch (err) {
    const msg = String(err) + (err && typeof err === 'object' && 'cause' in err ? String((err as { cause?: unknown }).cause) : '');
    if (/fetch failed|certificate|UNABLE_TO_VERIFY|SELF_SIGNED|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      try {
        return fetchCursorPeriodUsageCurl(token);
      } catch (curlErr) {
        throw curlErr;
      }
    }
    throw err;
  }
}

export function usageFromUsageFile(raw: unknown): AccountUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const fetchedAt = num(r.fetchedAt);
  if (fetchedAt === undefined) return undefined;
  return parsePeriodUsageBody(
    {
      billingCycleEnd: r.billingCycleEndMs,
      planUsage: {
        totalPercentUsed: r.includedPercent,
        autoPercentUsed: r.autoPercent,
        apiPercentUsed: r.apiPercent,
      },
    },
    Math.round(fetchedAt),
  )?.usage;
}

export function readCursorUsageFile(path: string): AccountUsage | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return usageFromUsageFile(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function writeCursorUsageFile(dir: string, file: CursorUsageFile): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, CURSOR_USAGE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export function cursorUsageFilePath(usageDir: string): string {
  return join(resolve(usageDir), CURSOR_USAGE_FILE);
}

/** Busca na API e grava ~/.habblaud/usage/.cursor.json (sem token). */
export async function pullCursorUsageToFile(usageDir: string, home: string = homedir()): Promise<AccountUsage | undefined> {
  const token = readCursorAccessToken(home);
  if (!token) return undefined;
  const fetchedAt = Date.now();
  const body = await fetchCursorPeriodUsage(token);
  const parsed = parsePeriodUsageBody(body, fetchedAt);
  if (!parsed) return undefined;
  writeCursorUsageFile(usageDir, parsed.file);
  return parsed.usage;
}
