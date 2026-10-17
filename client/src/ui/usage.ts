// Cartões de USO POR CONTA na barra superior: sessão de 5 horas e semanal, com reinício e origem dos números.
// Regras de apresentação:
// - número velho nunca passa por atual: janela que já renovou depois da leitura mostra "—" e "renovada";
//   números antigos ficam acinzentados com a idade ("há 6 d") no cabeçalho ou, no celular, um selo no chip;
// - o reinício vem com verbo implícito no ícone ↻ e contagem regressiva quando falta menos de um dia;
// - conta sem números diz "sem dados de uso" e oferece "Como ativar" (mod do Habblaud, recomendado).
// Conta do Codex: os números vêm dos arquivos de sessão dele, que só se renovam enquanto alguma sessão roda; por isso
// a idade ("há 12 min") fica sempre à mostra. Sem cota nem créditos ("sem cota") nunca vira 0%. Não há o que
// instalar para o uso: "Como funciona" abre a ajuda na seção do Codex. Sem Opus/Sonnet nem e-mail (só o plano).
import type { AccountInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { relativeTime, usageLevel, usageWindowMs, usageWindowView, type UsageWindowView } from './format';
import { ICONS } from './icons';
import { isCodex, isCursor, isGemini } from './provider';
import { usageRowFits } from './usage-row';
import { createAccountChip, createProviderTag, updateAccountChip, updateProviderTag } from './widgets';
import { tr } from '../../../shared/i18n';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: tr('cache do /usage do Claude Code'),
  statusline: tr('ao vivo (statusline do Claude Code)'),
  codex: tr('arquivos do Codex'),
  cursor: tr('API do Cursor (/usage)'),
};

/** Origem para mostrar: o arquivo ao vivo pode ter sido gravado pelo mod do Habblaud ou pelo tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return tr('ao vivo (mod do Habblaud)');
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * Como ligar o uso de uma conta, em ordem de preferência (dica do cartão e ajuda).
 * Trechos entre crases viram código (sem quebra de linha no meio do comando).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    tr('Recomendado: instala o mod do Habblaud no Claude Code (2.1.287 ou mais novo), que passa o uso de 5 h e da semana ao vivo. Rode na pasta do Habblaud, no computador onde o Claude Code roda; nas sessões já abertas, `/reload-plugins`.'),
  ],
  [
    'npm run usage:install',
    tr('No Claude Code anterior ao 2.1.287: liga um tap na linha de status, que passa os mesmos números ao vivo.'),
  ],
  ['/usage', tr('Sem instalar nada: rode `/usage` no Claude Code desta conta para atualizar o cache (os números envelhecem até a próxima vez).')],
];

/** Texto com trechos `assim` como código. */
export function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

interface Meter {
  el: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  reset: HTMLElement;
  resetLong: HTMLElement;
  resetShort: HTMLElement;
}

interface CardRefs {
  chip: HTMLElement;
  flag: HTMLElement;
  name: HTMLElement;
  prov: HTMLElement;
  email: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  meters: HTMLElement;
  five: Meter;
  week: Meter;
  msg: HTMLElement;
  msgLong: HTMLElement;
  msgShort: HTMLElement;
  how: HTMLButtonElement;
  howLong: HTMLElement;
  howShort: HTMLElement;
  tip: HTMLElement;
  tipTitle: HTMLElement;
  tipRows: HTMLElement;
  tipNote: HTMLElement;
  tipSetup: HTMLElement;
}

let tipSeq = 0;

function createMeter(long: string, short: string, title: string): Meter {
  const bar = h('span', { class: 'ui-meter__bar' }, h('span', { class: 'ui-meter__fill' }));
  const pct = h('span', { class: 'ui-meter__pct' });
  const resetLong = h('span', { class: 'ui-meter__reset-long' });
  const resetShort = h('span', { class: 'ui-meter__reset-short' });
  const reset = h('span', { class: 'ui-meter__reset' }, resetLong, resetShort);
  const label = h(
    'span',
    { class: 'ui-meter__label' },
    h('span', { class: 'ui-meter__label-long', text: long }),
    h('span', { class: 'ui-meter__label-short', text: short, attrs: { 'aria-hidden': 'true' } }),
  );
  const el = h('div', { class: 'ui-meter', role: 'img', attrs: { 'aria-label': title } }, label, bar, pct, reset);
  return { el, bar, pct, reset, resetLong, resetShort };
}

function updateMeter(m: Meter, view: UsageWindowView | null, windowName: string): void {
  if (!view || view.pct === null) {
    setVariant(m.el, 'is-', 'none');
    m.el.classList.remove('is-zero');
    m.el.classList.toggle('is-renewed', !!view?.renewed);
    setStyleVar(m.bar, '--pct', '0');
    setText(m.pct, '—');
    setText(m.resetLong, view?.renewed ? tr('↻ renovada') : '');
    setText(m.resetShort, '');
    const text = view ? `${windowName}: ${view.summary}` : tr('{0}: sem dados', [windowName]);
    setAttr(m.el, 'aria-label', text);
    setTitle(m.el, view?.renewed ? tr('{0}: a janela já renovou depois da última leitura; o uso atual é desconhecido.', [windowName]) : text);
    return;
  }
  const p = view.pct;
  m.el.classList.remove('is-renewed');
  setVariant(m.el, 'is-', usageLevel(p));
  m.el.classList.toggle('is-zero', p === 0);
  setStyleVar(m.bar, '--pct', String(p));
  setText(m.pct, `${p}%`);
  setText(m.resetLong, view.reset ? `↻ ${view.reset}` : '');
  setText(m.resetShort, view.resetShort ? `↻${view.resetShort}` : '');
  setAttr(m.el, 'aria-label', `${windowName}: ${view.summary}`);
  setTitle(m.el, `${windowName}: ${view.summary}`);
}

function syncRows(dl: HTMLElement, rows: [string, string][]): void {
  while (dl.children.length > rows.length * 2) dl.lastElementChild!.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2] as HTMLElement | undefined;
    let dd = dl.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt || !dd) {
      dt = h('dt');
      dd = h('dd');
      dl.append(dt, dd);
    }
    setText(dt, k);
    setText(dd, v);
  });
}

/** Passo a passo para ligar o uso (dica do cartão e ajuda). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

/** ok/stale: números recentes/antigos; empty: sem números; noquota: Codex sem cota nem créditos (nunca 0%). */
export type CardState = 'ok' | 'stale' | 'empty' | 'noquota';

function hasWindows(a: Pick<AccountInfo, 'usage'>): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Estado efetivo do cartão. */
export function cardState(a: Pick<AccountInfo, 'usage' | 'usageStatus'>): CardState {
  // "Sem cota" vem antes: a leitura não traz janelas, mas não é "sem dados".
  if (a.usage?.noQuota) return 'noquota';
  // Leitura sem nenhuma das janelas (ex.: cache do /usage sem números) vale como "sem dados".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

/** A idade dos números fica sempre à mostra? (Codex: só se renovam enquanto alguma sessão roda.) */
export function showsUsageAge(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): boolean {
  if (!a.usage) return false;
  const state = cardState(a);
  return state === 'stale' || (isCodex(a) && state !== 'empty');
}

/** Linha embaixo do nome: e-mail; no Codex (sem e-mail), o plano; nas outras, a pasta. */
export function usageSubtitle(a: Pick<AccountInfo, 'email' | 'plan' | 'configDir' | 'provider'> & Partial<Pick<AccountInfo, 'sessions'>>): string {
  if (isCursor(a)) {
    if (a.email) return a.email;
    return a.sessions
      ? tr('{0} sessão(ões) Cursor no escritório', [a.sessions])
      : tr('Cursor IDE · nenhuma sessão aberta');
  }
  if (isGemini(a)) {
    return a.sessions
      ? tr('{0} sessão(ões) Gemini no escritório', [a.sessions])
      : tr('Gemini CLI · nenhuma sessão aberta');
  }
  if (a.email) return a.email;
  if (isCodex(a)) return a.plan ? tr('plano {0}', [a.plan]) : 'Codex';
  return a.configDir;
}

/** Mensagem no lugar das barras (estados sem números): [longa, curta]. */
export function usageMessage(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): [string, string] {
  const state = cardState(a);
  if (state === 'noquota') return [tr('sem cota'), tr('sem cota')];
  if (isCodex(a)) return [tr('sem dados ainda'), tr('sem dados')];
  return [tr('sem dados de uso'), tr('sem dados')];
}

/** Explicação do cartão de uma conta do Codex (dica); '' nas outras. */
export function codexUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCodex(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty') return tr('Não precisa instalar nada: os números chegam com a próxima sessão do Codex.');
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  if (state === 'noquota')
    return tr('Na última leitura ({0}), a conta estava sem cota nem créditos para usar (ex.: os créditos do workspace acabaram). Não é 0%: o Codex não informou as janelas. Os números voltam com a próxima sessão.', [age]);
  return tr('O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura ({0}).', [age]);
}

export class UsageCards {
  readonly el: HTMLElement;
  private list: KeyedList<AccountInfo>;
  private refs = new WeakMap<HTMLElement, CardRefs>();

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-usage', role: 'group', attrs: { 'aria-label': tr('Uso por conta') } });
    this.list = new KeyedList<AccountInfo>(this.el, {
      key: (a) => a.id,
      create: () => this.createCard(),
      update: (el, a) => this.updateCard(el, a),
    });
    // A largura da janela mudou: refaz a conta de cabem-ou-não (ver fit()).
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(ctx.root);
  }

  render(): void {
    const accounts = [...(this.ctx.store.snapshot?.accounts ?? [])].sort((a, b) => {
      const sa = a.sessions ?? 0;
      const sb = b.sessions ?? 0;
      if (sa !== sb) return sb - sa;
      if (isCursor(a) !== isCursor(b)) return isCursor(a) ? -1 : 1;
      if (isGemini(a) !== isGemini(b)) return isGemini(a) ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    this.list.sync(accounts);
    this.el.classList.toggle('is-empty', accounts.length === 0);
    setStyleVar(this.el, '--count', String(accounts.length));
    // Medir força o layout da página, e o render roda a cada quadro no replay: só quando as contas mudam (a largura da
    // janela fica com o ResizeObserver do construtor).
    const key = accounts.map((a) => a.id).join('|');
    if (key !== this.fitKey) {
      this.fitKey = key;
      this.fit();
    }
  }

  /** Contas da última medida em fit() (ver render). */
  private fitKey = '';

  /**
   * Os cartões não cabem na linha da barra (muitas contas ou janela estreita)? Então vão para uma segunda linha
   * (`has-usage-row` na raiz, regras em styles.css). Só conta os tamanhos mínimos, que não dependem de a fila estar
   * numa linha ou na outra, então o resultado não oscila. No celular a barra já tem duas linhas (bloco próprio do CSS).
   */
  private fit(): void {
    const bar = this.el.parentElement;
    if (!bar) return;
    if (window.matchMedia('(max-width: 600px)').matches) {
      this.ctx.root.classList.remove('has-usage-row');
      return;
    }
    const barStyle = getComputedStyle(bar);
    const px = (v: string) => Number.parseFloat(v) || 0;
    // Largura natural dos outros itens (scrollWidth): na linha única eles encolhem, na linha de baixo não, e a
    // decisão não pode depender de em qual dos dois estados a barra está.
    const others = [...bar.children]
      .filter((c) => c !== this.el && getComputedStyle(c).display !== 'none')
      .map((c) => Math.max((c as HTMLElement).offsetWidth, c.scrollWidth));
    const fits = usageRowFits({
      barWidth: bar.clientWidth - px(barStyle.paddingLeft) - px(barStyle.paddingRight),
      others,
      gap: px(barStyle.columnGap),
      cardGap: px(getComputedStyle(this.el).columnGap),
      cards: [...this.el.children].map((c) => px(getComputedStyle(c).minWidth)),
    });
    this.ctx.root.classList.toggle('has-usage-row', !fits);
  }

  private createCard(): HTMLElement {
    const tipId = `ui-usage-tip-${++tipSeq}`;
    const chip = createAccountChip('lg');
    const flag = h('span', { class: 'ui-usage-card__flag', hidden: true, attrs: { 'aria-hidden': 'true' } });
    flag.innerHTML = ICONS.clock;
    const name = h('span', { class: 'ui-usage-card__name' });
    const prov = createProviderTag('ui-prov--xs');
    const email = h('span', { class: 'ui-usage-card__email' });
    const stateIcon = h('span', { class: 'ui-usage-card__state-icon', attrs: { 'aria-hidden': 'true' } });
    stateIcon.innerHTML = ICONS.clock;
    const stateText = h('span');
    const state = h('span', { class: 'ui-usage-card__state' }, stateIcon, stateText);
    const five = createMeter('5h', '5h', tr('Sessão de 5 horas'));
    const week = createMeter(tr('Semana'), tr('Sem.'), tr('Limite semanal'));
    const meters = h('div', { class: 'ui-usage-card__meters' }, five.el, week.el);
    const msgLong = h('span', { class: 'ui-usage-card__msg-long', text: tr('sem dados de uso') });
    const msgShort = h('span', { class: 'ui-usage-card__msg-short', text: tr('sem dados'), attrs: { 'aria-hidden': 'true' } });
    const howLong = h('span', { class: 'ui-usage-card__how-long', text: tr('Como ativar') });
    const howShort = h('span', { class: 'ui-usage-card__how-short', text: tr('Ativar'), attrs: { 'aria-hidden': 'true' } });
    const howBtn = h(
      'button',
      {
        class: 'ui-usage-card__how',
        type: 'button',
        title: tr('Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)'),
        on: { click: () => this.ctx.openHelp(howBtn.dataset.help === 'codex' ? 'codex' : 'usage') },
      },
      howLong,
      howShort,
    );
    const msg = h('div', { class: 'ui-usage-card__msg' }, h('span', { class: 'ui-usage-card__msg-text' }, msgLong, msgShort), howBtn);
    const tipTitle = h('div', { class: 'ui-usage-tip__title' });
    const tipRows = h('dl', { class: 'ui-kv' });
    const tipNote = h('p', { class: 'ui-usage-tip__note' });
    const tipSetup = h('div', { class: 'ui-usage-tip__setup' }, h('p', { class: 'ui-usage-tip__setup-title', text: tr('Como ter o uso ao vivo') }), createUsageSetup());
    const tip = h('div', { class: 'ui-usage-tip', role: 'tooltip', attrs: { id: tipId } }, tipTitle, tipRows, tipNote, tipSetup);
    const card = h(
      'div',
      { class: 'ui-usage-card', tabIndex: 0, attrs: { 'aria-describedby': tipId } },
      chip,
      flag,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, name, prov, email, state), meters, msg),
      tip,
    );
    this.refs.set(card, {
      chip,
      flag,
      name,
      prov,
      email,
      state,
      stateText,
      meters,
      five,
      week,
      msg,
      msgLong,
      msgShort,
      how: howBtn,
      howLong,
      howShort,
      tip,
      tipTitle,
      tipRows,
      tipNote,
      tipSetup,
    });
    return card;
  }

  private updateCard(card: HTMLElement, a: AccountInfo): void {
    const r = this.refs.get(card)!;
    const now = this.ctx.now();
    const codex = isCodex(a);
    const cursor = isCursor(a);
    updateAccountChip(r.chip, a);
    setStyleVar(card, '--acc', a.color);
    setText(r.name, a.name);
    updateProviderTag(r.prov, cursor ? 'cursor' : isGemini(a) ? 'gemini' : codex ? 'codex' : 'claude', a.name);
    setText(r.email, usageSubtitle(a));
    setAttr(
      card,
      'aria-label',
      cursor ? tr('{0} (Cursor)', [a.name]) : tr('{0}{1}: uso do plano', [a.name, codex ? ' (Codex)' : '']),
    );

    const usage = a.usage;
    const state = cardState(a);
    setVariant(card, 'is-', state);
    const five = usage ? usageWindowView(usage.fiveHour, usage.fetchedAt, now, usageWindowMs(usage.source, 'five')) : null;
    const week = usage ? usageWindowView(usage.sevenDay, usage.fetchedAt, now, usageWindowMs(usage.source, 'week')) : null;
    const showMeters = hasWindows(a);
    setHidden(r.meters, !showMeters);
    if (usage && showMeters) {
      const fiveLabel = cursor && usage.source === 'cursor' ? tr('Auto (Cursor)') : tr('Sessão de 5 horas');
      const weekLabel = cursor && usage.source === 'cursor' ? tr('Included (Cursor)') : tr('Semana');
      updateMeter(r.five, five, fiveLabel);
      updateMeter(r.week, week, weekLabel);
      const fiveLabelEl = r.five.el.querySelector('.ui-meter__label-long') as HTMLElement | null;
      const weekLabelEl = r.week.el.querySelector('.ui-meter__label-long') as HTMLElement | null;
      const fiveShort = r.five.el.querySelector('.ui-meter__label-short') as HTMLElement | null;
      const weekShort = r.week.el.querySelector('.ui-meter__label-short') as HTMLElement | null;
      if (fiveLabelEl) setText(fiveLabelEl, cursor && usage.source === 'cursor' ? tr('Auto') : '5h');
      if (weekLabelEl) setText(weekLabelEl, cursor && usage.source === 'cursor' ? tr('Incl.') : tr('Semana'));
      if (fiveShort) setText(fiveShort, cursor && usage.source === 'cursor' ? tr('Auto') : '5h');
      if (weekShort) setText(weekShort, cursor && usage.source === 'cursor' ? tr('Incl.') : tr('Sem.'));
    }
    r.meters.classList.toggle('is-dim', state !== 'ok');

    // Idade dos números antigos no cabeçalho (no celular, um selo no chip faz esse papel). No Codex a idade fica
    // sempre à mostra (os números só se renovam enquanto alguma sessão roda), discreta enquanto são recentes.
    const stale = state === 'stale';
    const showAge = showsUsageAge(a);
    setHidden(r.state, !showAge);
    setHidden(r.flag, !stale);
    r.state.classList.toggle('is-fresh', showAge && a.usageStatus === 'ok');
    if (showAge && usage) {
      const age = relativeTime(usage.fetchedAt, now);
      setText(r.stateText, age);
      setTitle(
        r.state,
        codex
          ? tr('Atualizado {0}: o Codex só grava o uso enquanto alguma sessão roda.', [age])
          : tr('Números de {0}: podem não refletir o uso atual.', [age]),
      );
    }

    // Sem números: "sem dados de uso" + "Como ativar" (no Codex, "Como funciona": não há o que instalar). Sem cota:
    // a mensagem, sem botão.
    const [msgLong, msgShort] = usageMessage(a);
    const cursorEmpty = cursor && state === 'empty';
    setText(
      r.msgLong,
      cursorEmpty ? tr('Plano mensal (Team): rode `npm run cursor:usage:pull` no host (ou deixe o cursor:bridge ativo).') : msgLong,
    );
    setText(r.msgShort, cursorEmpty ? tr('uso') : msgShort);
    setHidden(r.msg, cursor ? !cursorEmpty : state !== 'empty' && state !== 'noquota');
    setHidden(r.how, cursor || state === 'noquota');
    r.msg.classList.toggle('is-noquota', state === 'noquota');
    setTitle(r.msg, state === 'noquota' ? codexUsageNote(a, now) : '');
    setText(r.howLong, codex ? tr('Como funciona') : tr('Como ativar'));
    setText(r.howShort, codex ? tr('Saber') : tr('Ativar'));
    r.how.dataset.help = codex ? 'codex' : 'usage';
    setTitle(r.how, codex ? tr('Como o uso do Codex chega ao Habblaud (abre a ajuda em “Codex”)') : tr('Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)'));
    this.updateTip(r, a, state, five, week, now);
  }

  private updateTip(r: CardRefs, a: AccountInfo, state: CardState, five: UsageWindowView | null, week: UsageWindowView | null, now: number): void {
    const codex = isCodex(a);
    const cursor = isCursor(a);
    setText(
      r.tipTitle,
      `${a.name}${cursor && !/cursor/i.test(a.name) ? ' · Cursor' : ''}${codex && !/codex/i.test(a.name) ? ' · Codex' : ''}${a.plan ? tr(' · plano {0}', [a.plan]) : ''}`,
    );
    const rows: [string, string][] = [];
    if (cursor) rows.push([tr('Ferramenta'), 'Cursor']);
    if (codex) rows.push([tr('Ferramenta'), 'Codex']);
    if (a.email) rows.push(['E-mail', a.email]);
    if (a.organization) rows.push([tr('Organização'), a.organization]);
    if (a.plan) rows.push([tr('Plano'), a.plan]);
    rows.push([tr('Pasta'), a.configDir]);
    rows.push([tr('Sessões abertas'), String(a.sessions)]);
    const u = a.usage;
    if (u && (u.fiveHour || u.sevenDay)) {
      const fiveRow = cursor ? tr('Auto (Cursor)') : tr('Sessão de 5 h');
      const weekRow = cursor ? tr('Included (Cursor)') : tr('Semana');
      rows.push([fiveRow, five?.summary ?? '—']);
      rows.push([weekRow, week?.summary ?? '—']);
      // Opus e Sonnet são janelas do Claude: no Codex não existem.
      const opus = codex || cursor ? null : usageWindowView(u.sevenDayOpus, u.fetchedAt, now, usageWindowMs(u.source, 'week'));
      const sonnet = codex || cursor ? null : usageWindowView(u.sevenDaySonnet, u.fetchedAt, now, usageWindowMs(u.source, 'week'));
      if (opus) rows.push([tr('Opus (semana)'), opus.summary]);
      if (sonnet) rows.push([tr('Sonnet (semana)'), sonnet.summary]);
    }
    if (u && state === 'noquota') rows.push([tr('Cota'), tr('sem cota nem créditos agora')]);
    if (u && (state !== 'empty' || codex)) {
      rows.push([tr('Origem'), sourceLabel(u)]);
      rows.push([tr('Atualizado'), relativeTime(u.fetchedAt, now)]);
    }
    syncRows(r.tipRows, rows);

    // Codex: a explicação dele, sem o passo a passo do Claude Code (não há o que instalar para o uso).
    if (cursor) {
      setText(
        r.tipNote,
        u?.source === 'cursor'
          ? tr(
              'Included e Auto vêm da mesma API do `/usage` do cursor-agent (arquivo ~/.habblaud/usage/.cursor.json no host). API fica no `/usage` ou no dashboard. Mensagens: npm run cursor:bridge.',
            )
          : tr(
              'O `/usage` do cursor-agent mostra Included, Auto e API. No host: `npm run cursor:usage:pull` ou deixe o cursor:bridge rodando (atualiza a cada 5 min).',
            ),
      );
      setHidden(r.tipNote, false);
      setHidden(r.tipSetup, true);
      return;
    }

    if (codex) {
      const note = codexUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      setHidden(r.tipSetup, true);
      return;
    }

    let note = '';
    if (state === 'empty')
      note = u ? tr('A última leitura ({0}, {1}) não trouxe números de 5 h nem da semana.', [sourceLabel(u), relativeTime(u.fetchedAt, now)]) : tr('Ainda não há números de uso para esta conta.');
    else if (state === 'stale') note = tr('Números antigos: refletem a última leitura, não o uso de agora.');
    else if (u?.source === 'cache') note = tr('Cache do /usage: atualiza quando alguém roda /usage nesta conta.');
    else if (five?.renewed || week?.renewed) note = tr('Uma das janelas já reiniciou depois da última leitura.');
    setText(r.tipNote, note);
    setHidden(r.tipNote, !note);
    // O passo a passo aparece sempre que os números não são ao vivo.
    const live = u?.source === 'statusline' && state === 'ok';
    setHidden(r.tipSetup, live);
  }
}
