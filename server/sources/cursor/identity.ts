// Nome do dev no escritório: team.json casa `cursorName` com o --name do wrapper ou o `name` do store.db do IDE.
// Sessões do Cursor IDE costumam vir como "Habblaud Cursor Agent" / "New Agent" — nomes genéricos que ignoramos
// e substituímos por HABBLAUD_CURSOR_IDE_NAME, `cursorIdeDefault` no team.json ou um alias exato em cursorName.
import type { TeamLookup } from '../../model/team';

const GENERIC = new Set(
  ['new agent', 'agent', 'cursor agent', 'habblaud cursor agent', 'default', 'composer'].map((s) => s.toLowerCase()),
);

export function isGenericCursorAgentName(name: string | undefined): boolean {
  if (!name?.trim()) return true;
  const k = name.trim().toLowerCase();
  if (GENERIC.has(k)) return true;
  if (/^habblaud\s+cursor(\s+agent)?$/i.test(name.trim())) return true;
  return false;
}

export interface CursorIdentityInput {
  storeName?: string;
  title?: string;
  role?: string;
  team?: TeamLookup;
  env?: NodeJS.ProcessEnv;
  /** IDE: só usa `storeName` se casar com `cursorName` no team.json; wrapper (--name) deixa true (padrão). */
  trustStoreName?: boolean;
  /** IDE: idem para `title` do meta.json (título da tarefa, não nome do dev). */
  trustTitle?: boolean;
}

export interface CursorIdentityHint {
  agentType?: string;
  cursorName?: string;
  name?: string;
  role?: string;
}

function memberHint(member: { name: string; role?: string; agentType?: string; cursorName?: string }, key?: string): CursorIdentityHint {
  return {
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.cursorName || key ? { cursorName: member.cursorName ?? key } : {}),
    name: member.name,
    ...(member.role ? { role: member.role } : {}),
  };
}

/** Dica para Office.teamMember (`agentType` ou `cursorName` → team.json). */
export function resolveCursorIdentityHint(input: CursorIdentityInput & { agentType?: string }): CursorIdentityHint | undefined {
  const team = input.team;
  const env = input.env ?? process.env;
  if (input.agentType?.trim()) {
    const m = team?.subagent(input.agentType.trim());
    if (m) return memberHint(m, input.agentType.trim());
  }
  const trustUnknownStore = input.trustStoreName !== false;
  const tryName = (raw: string | undefined, fromStoreDb = false): CursorIdentityHint | undefined => {
    if (!raw?.trim()) return undefined;
    const n = raw.trim();
    const byCursor = team?.cursor(n);
    if (byCursor) return memberHint(byCursor, n);
    const byType = team?.subagent(n);
    if (byType) return memberHint(byType, n);
    if (fromStoreDb && !trustUnknownStore) return undefined;
    if (!isGenericCursorAgentName(n)) return { cursorName: n, name: n, ...(input.role ? { role: input.role } : {}) };
    return undefined;
  };

  const fromStore = tryName(input.storeName, true);
  if (fromStore) return fromStore;

  const envName = env.HABBLAUD_CURSOR_IDE_NAME?.trim() || env.HABBLAUD_CURSOR_NAME?.trim();
  const fromEnv = tryName(envName);
  if (fromEnv) return fromEnv;

  const ideDefault = team?.cursorIdeDefault?.();
  if (ideDefault) return memberHint(ideDefault, ideDefault.cursorName ?? ideDefault.name);

  const fromTitle = input.trustTitle === false ? tryName(input.title, true) : tryName(input.title);
  if (fromTitle) return fromTitle;

  return undefined;
}
