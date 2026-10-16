// Metadados públicos da conta Cursor CLI (~/.cursor/cli-config.json): e-mail e time. Sem tokens (auth fica em ~/.config/cursor/).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../../shared/i18n';

export interface CursorCliProfile {
  email?: string;
  organization?: string;
  plan?: string;
}

/** Lê authInfo do cli-config (best-effort; arquivo ausente ou ilegível → undefined). */
export function readCursorCliProfile(cursorHome: string): CursorCliProfile | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(cursorHome, 'cli-config.json'), 'utf8');
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
  const auth = (parsed as Record<string, unknown>).authInfo;
  if (!auth || typeof auth !== 'object') return undefined;
  const rec = auth as Record<string, unknown>;
  const email = typeof rec.email === 'string' && rec.email.trim() ? rec.email.trim() : undefined;
  const team = typeof rec.teamName === 'string' && rec.teamName.trim() ? rec.teamName.trim() : undefined;
  if (!email && !team) return undefined;
  return {
    ...(email ? { email } : {}),
    ...(team ? { organization: team, plan: tr('Team') } : {}),
  };
}
