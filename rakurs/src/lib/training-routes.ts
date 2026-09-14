/**
 * URL state of the «Обучение агента» section.
 *
 * Pure functions only: the screen reads the tab and teach mode from the query string, and
 * every link into the section (including the legacy `/knowledge` and `/coach` URLs) is built
 * here, so one place decides which parameters belong to which tab.
 */

export type TrainingTab = 'knowledge' | 'products' | 'script' | 'replies' | 'teach' | 'review';
export type TeachMode = 'chats' | 'coach' | 'import';

export const TRAINING_TABS: ReadonlyArray<{ id: TrainingTab; label: string; ownerOnly: boolean }> = [
  { id: 'knowledge', label: 'Знания', ownerOnly: false },
  { id: 'products', label: 'Товары', ownerOnly: false },
  { id: 'script', label: 'Скрипт продаж', ownerOnly: false },
  { id: 'replies', label: 'Как отвечает', ownerOnly: false },
  { id: 'teach', label: 'Научить', ownerOnly: true },
  { id: 'review', label: 'На проверке', ownerOnly: true },
];

const TEACH_MODES: readonly TeachMode[] = ['chats', 'coach', 'import'];

/** Parameters a «Так нельзя» correction deep link carries into the coach. */
export const CORRECTION_PARAMS = ['conversation', 'reply', 'session', 'turn', 'message'] as const;

const hasCorrectionParam = (params: URLSearchParams) => CORRECTION_PARAMS.some((key) => params.has(key));

export function visibleTabs(owner: boolean): TrainingTab[] {
  return TRAINING_TABS.filter((tab) => owner || !tab.ownerOnly).map((tab) => tab.id);
}

/**
 * The tab to show. `noteCount === null` means the note count is still loading; it is treated
 * as a non-empty base so the page does not jump to «Научить» and back.
 */
export function trainingTabFromSearch(
  params: URLSearchParams,
  ctx: { owner: boolean; noteCount: number | null },
): TrainingTab {
  const requested = params.get('tab');
  const visible = visibleTabs(ctx.owner);
  if (visible.includes(requested as TrainingTab)) return requested as TrainingTab;
  if (ctx.owner && (params.has('generation') || hasCorrectionParam(params))) return 'teach';
  if (ctx.owner && ctx.noteCount === 0) return 'teach';
  return 'knowledge';
}

export function teachModeFromSearch(params: URLSearchParams): TeachMode | null {
  const requested = params.get('teach');
  if (TEACH_MODES.includes(requested as TeachMode)) return requested as TeachMode;
  if (params.has('generation')) return 'chats';
  if (hasCorrectionParam(params)) return 'coach';
  return null;
}

export function withoutCorrectionParams(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of CORRECTION_PARAMS) next.delete(key);
  return next;
}

/**
 * The query string for choosing a way inside «Научить» (or `null` for the chooser). Each way
 * starts fresh: the previous way's generation run and correction context are dropped.
 */
export function teachModeSearch(current: URLSearchParams, mode: TeachMode | null): URLSearchParams {
  const next = withoutCorrectionParams(trainingSearch(current, 'teach', mode));
  next.delete('generation');
  return next;
}

/**
 * The query string for a tab change. State owned by the tab being left is dropped: a
 * selected note belongs to «Знания», a generation run and a correction to «Научить».
 */
export function trainingSearch(current: URLSearchParams, tab: TrainingTab, teach?: TeachMode | null): URLSearchParams {
  let next = new URLSearchParams(current);
  next.set('tab', tab);
  if (tab !== 'knowledge') next.delete('note');
  if (tab !== 'teach') {
    next.delete('teach');
    next.delete('generation');
    next = withoutCorrectionParams(next);
  } else if (teach) {
    next.set('teach', teach);
  } else if (teach === null) {
    next.delete('teach');
  }
  return next;
}

export function legacyKnowledgeSearch(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  const tab = current.get('tab');
  if (tab === 'drafts' || tab === 'runs' || (tab === null && current.has('generation'))) {
    next.set('tab', 'teach');
    next.set('teach', 'chats');
  } else if (tab === 'sources') {
    next.set('tab', 'teach');
    next.set('teach', 'import');
  } else {
    next.set('tab', 'knowledge');
  }
  return next;
}

export function legacyCoachSearch(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('tab', 'teach');
  next.set('teach', 'coach');
  return next;
}
