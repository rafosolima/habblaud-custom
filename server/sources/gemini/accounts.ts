// Contas do Gemini CLI: uma pasta GEMINI_HOME (~/.gemini) por instalação. Node puro (também docker-up via tsx).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';
import { tr } from '../../../shared/i18n';

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

/** Pasta padrão: GEMINI_HOME ou $HOME/.gemini. */
export function defaultGeminiHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.GEMINI_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.gemini');
}

/** Tem cara de instalação do Gemini CLI (sessões em tmp/ ou config do CLI). */
export function isGeminiHome(p: string): boolean {
  if (!isDir(p)) return false;
  if (isDir(join(p, 'tmp'))) return true;
  if (existsSync(join(p, 'config', 'config.json'))) return true;
  return false;
}

/**
 * Pastas observadas. HABBLAUD_GEMINI_DIRS substitui; senão GEMINI_HOME e $HOME/.gemini* que passem em isGeminiHome.
 */
export function discoverGeminiHomes(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_GEMINI_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isGeminiHome);
  const found: string[] = [];
  const main = defaultGeminiHome(env, home);
  if (isGeminiHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.gemini')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isGeminiHome(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

export function geminiOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'gemini');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

function letterCandidates(dir: string): string[] {
  const suffix = /^\.?gemini[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('G', 'M', 'N', 'P', 'Q');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface GeminiDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  taken?: { shorts: string[]; colors: string[] };
}

/** Metadados das contas do Gemini (uma por pasta observada). */
export function detectGeminiAccounts(dirs: string[], opts: GeminiDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? env.HOME ?? homedir();
  const overrides = geminiOverrides(env.HABBLAUD_ACCOUNTS);
  const aliases = readShellAliases(home, 'gemini');
  const byDir = shortcutsByDir(aliases, home);
  const takenShort = new Set((opts.taken?.shorts ?? []).map((s) => s.toUpperCase()));
  const takenColor = new Set(opts.taken?.colors ?? []);
  const ids = accountIds(dirs.map((d) => basename(d) === '.gemini' ? '.gemini' : basename(d)));
  return dirs.map((dir, i) => {
    const id = ids[i] ?? `.gemini${i ? `-${i}` : ''}`;
    const o = matchOverride(overrides, id, dir, home);
    const alias = byDir.get(dir);
    let short = o?.short?.trim().toUpperCase().slice(0, 1) ?? alias?.trim().toUpperCase().slice(0, 1);
    if (!short || takenShort.has(short)) {
      for (const c of letterCandidates(dir)) {
        if (!takenShort.has(c)) {
          short = c;
          break;
        }
      }
    }
    if (!short) short = 'G';
    takenShort.add(short);
    const color = o?.color ?? ACCOUNT_COLORS.find((c) => !takenColor.has(c)) ?? '#4285f4';
    takenColor.add(color);
    const configDir = o?.configDir ? expandHome(o.configDir, home) : dir;
    const name = o?.name?.trim() || tr('Conta {0}', [short]);
    return {
      id: o?.id ?? id,
      provider: 'gemini',
      configDir,
      short,
      name,
      color,
      ...(o?.email ? { email: o.email } : {}),
      ...(o?.organization ? { organization: o.organization } : {}),
      ...(o?.plan ? { plan: o.plan } : {}),
    };
  });
}
