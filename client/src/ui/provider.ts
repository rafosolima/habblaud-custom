// De qual ferramenta é cada coisa (Claude Code ou Codex) e os textos que mudam com ela. Puro (sem DOM): testado em
// ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual do Codex (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda e letra na
// cor da conta, cantos em degrau) e, onde há espaço, um selo de texto "Codex" ao lado do nome.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isCursor(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'cursor';
}

export function isGemini(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'gemini';
}

/** O id de conta tem cara da conta do Cursor (".cursor", "demo:.cursor")? Como looksLikeCodexId. */
export function looksLikeCursorId(id: string): boolean {
  return /(?:^|[:/\\])\.?cursor(?:[-_.~]|$)/i.test(id);
}

export function looksLikeGeminiId(id: string): boolean {
  return /(?:^|[:/\\])\.?gemini(?:[-_.~]|$)/i.test(id);
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : looksLikeCursorId(fallbackId) ? 'cursor' : looksLikeGeminiId(fallbackId) ? 'gemini' : 'claude');
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). A pasta padrão do Codex (".codex") vira "X"; a do Claude Code,
 * "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|cursor|gemini)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : provider === 'cursor' ? 'R' : provider === 'gemini' ? 'G' : '?';
}

/** O selo "Codex"/"Cursor" ao lado do nome da conta (não repete quando o nome já diz a ferramenta). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider !== 'claude' && !accountName.toLowerCase().includes(PROVIDER_NAME[provider].toLowerCase());
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider !== 'claude' ? ` · ${PROVIDER_NAME[provider]}` : ''}` : tr('Conta desconhecida');
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex não é um atalho); o Codex só entra quando há uma conta dele.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a)));
  if (!accounts.some(isCodex) && !accounts.some(isGemini)) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
  return tr('Abra o Claude Code{0}, o Codex ou o Gemini CLI em qualquer projeto e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Cursor sem entregador (npm run cursor:bridge ou CLI no PATH). */
export const CURSOR_BRIDGE_HINT = tr(
  'Para mandar mensagens ao Cursor: deixe npm run cursor:bridge rodando no computador (com o Habblaud no Docker) ou rode o Habblaud fora do Docker com o `agent` no PATH',
);

/** Com entregador: explica que não espelha o cursor-agent interativo no terminal. */
export const CURSOR_MIRROR_HINT = tr(
  'Mensagens daqui usam `agent --resume` à parte: não espelham o terminal interativo do cursor-agent, e o que você digita lá só aparece aqui quando o transcript atualiza. Use um canal só — feche o cursor-agent no terminal ou mande mensagens só pelo escritório (terminal de leitura abaixo).',
);

/** Permissões pelo escritório (hooks do Cursor). */
export const CURSOR_PERMISSIONS_HINT = tr('Para aprovar ferramentas pelo Habblaud como no Claude: `npm run cursor:hooks:install` e aprove os hooks na aba Hooks do Cursor.');

/** Texto da gaveta para agentes Cursor (chats IDE / cursor-agent). */
export function cursorDrawerHint(canMessage: boolean | undefined): string {
  const parts = [canMessage ? CURSOR_MIRROR_HINT : CURSOR_BRIDGE_HINT, CURSOR_PERMISSIONS_HINT];
  return parts.join(' ');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
