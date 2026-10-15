// Equipe (opcional): ~/.habblaud/team.json (HABBLAUD_TEAM_FILE substitui) dá nome e papel fixos a quem trabalha
// no escritório. Só leitura; relido quando o arquivo muda (conferido no máximo a cada RECHECK_MS). Sem o arquivo, nada
// muda: os nomes continuam vindo do sorteio (model/names.ts) e dos personagens dos projetos.
//
//   {"members": [
//     {"agentType": "renato-techlead", "name": "Renato", "role": "TechLead", "main": true},
//     {"agentType": "tati-po", "name": "Tati", "role": "Product Owner"},
//     {"cursorName": "Lucas", "name": "Lucas", "role": "Dev - Mestre"}
//   ]}
//
// Casamentos (ver Office): `agentType` = tipo do subagente do Claude Code (o `agentType` do .meta.json ou o
// `subagent_type` da chamada Agent), sem diferenciar maiúsculas; `cursorName` = o `--name` do wrapper do Cursor
// (mod/habblaud-cursor/run.mjs); `main: true` = sessões principais do Claude Code (com `cwd`, só as de projetos dentro
// dessa pasta). O personagem do projeto (editor) continua valendo antes da regra `main`.
import { readFileSync, statSync } from 'node:fs';
import { nameKey } from '../../shared/appearance';
import { errMsg, log } from '../log';
import { normalizeCwd } from './rooms';
import { tr } from '../../shared/i18n';

export interface TeamMember {
  name: string;
  role?: string;
  agentType?: string;
  cursorName?: string;
  main?: boolean;
  /** Com `main`: só sessões em projetos dentro desta pasta (normalizada). */
  cwd?: string;
}

/** O que o Office pergunta à equipe (o TeamRoster, ou um objeto fixo nos testes). */
export interface TeamLookup {
  subagent(agentType: string): TeamMember | undefined;
  cursor(name: string): TeamMember | undefined;
  main(cwd: string): TeamMember | undefined;
}

const NAME_MAX = 24;
const ROLE_MAX = 32;
const MEMBERS_MAX = 200;
export const RECHECK_MS = 2_000;

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : undefined;
}

/** Membros válidos de um team.json (entradas fora do formato são ignoradas). */
export function parseTeam(raw: unknown): TeamMember[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { members?: unknown }).members) ? (raw as { members: unknown[] }).members : [];
  const out: TeamMember[] = [];
  for (const item of list.slice(0, MEMBERS_MAX)) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const name = clean(v.name, NAME_MAX);
    if (!name) continue;
    const m: TeamMember = { name };
    const role = clean(v.role, ROLE_MAX);
    if (role) m.role = role;
    const agentType = clean(v.agentType, 120);
    if (agentType) m.agentType = agentType;
    const cursorName = clean(v.cursorName, NAME_MAX);
    if (cursorName) m.cursorName = cursorName;
    if (v.main === true) m.main = true;
    const cwd = clean(v.cwd, 4_096);
    if (cwd) m.cwd = normalizeCwd(cwd);
    if (m.agentType || m.cursorName || m.main) out.push(m);
  }
  return out;
}

/** Pasta `cwd` está dentro de `root` (ou é ela)? Ambas normalizadas. */
function within(cwd: string, root: string): boolean {
  const r = root.replace(/\/+$/, '');
  return cwd === r || cwd.startsWith(`${r}/`);
}

export class TeamRoster implements TeamLookup {
  private members: TeamMember[] = [];
  private mtimeMs = -1;
  private checkedAt = -Infinity;
  private readonly now: () => number;

  /** `file` null = sem equipe. */
  constructor(
    private readonly file: string | null,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Membros atuais (relê o arquivo se ele mudou). */
  list(): readonly TeamMember[] {
    this.refresh();
    return this.members;
  }

  subagent(agentType: string): TeamMember | undefined {
    const k = agentType.trim().toLowerCase();
    return k ? this.list().find((m) => m.agentType?.toLowerCase() === k) : undefined;
  }

  cursor(name: string): TeamMember | undefined {
    const k = nameKey(name);
    return k ? this.list().find((m) => m.cursorName !== undefined && nameKey(m.cursorName) === k) : undefined;
  }

  main(cwd: string): TeamMember | undefined {
    const room = normalizeCwd(cwd);
    return this.list().find((m) => m.main && (!m.cwd || within(room, m.cwd)));
  }

  private refresh(): void {
    if (!this.file) return;
    const now = this.now();
    if (now - this.checkedAt < RECHECK_MS) return;
    this.checkedAt = now;
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      if (this.mtimeMs !== -1) this.members = [];
      this.mtimeMs = -1;
      return;
    }
    if (mtime === this.mtimeMs) return;
    this.mtimeMs = mtime;
    try {
      this.members = parseTeam(JSON.parse(readFileSync(this.file, 'utf8')));
      log.clearOnce('team-read');
    } catch (err) {
      this.members = [];
      log.warnOnce('team-read', tr('{0} ilegível ({1}); sem nomes da equipe.', [this.file, errMsg(err)]));
    }
  }
}
