import type { AdAccount, AdMeta, Creative, DeliveryStatus } from '@/types';

/**
 * Агрегаты по объявлениям. Функции принимают данные аргументами и ничего не
 * импортируют из src/data: одни и те же расчёты работают и на моках, и на
 * ответах бэкенда.
 */

export type AdsMeta = Record<string, AdMeta>;

/** Сумма потерь по креативу — счётчики из блока «почему теряем». */
export function lossesOf(c: Creative): number {
  return c.losses.reduce((a, l) => a + parseInt(l.count, 10), 0);
}

export interface Totals {
  spendKzt: number;
  spendUsd: number;
  revenue: number;
  purchases: number;
  dialogs: number;
  qual: number;
  measure: number;
  sentToMeta: number;
  losses: number;
  impressions: number;
  clicks: number;
  metaResults: number;
  metaPurch: number;
}

export const emptyTotals: Totals = {
  spendKzt: 0,
  spendUsd: 0,
  revenue: 0,
  purchases: 0,
  dialogs: 0,
  qual: 0,
  measure: 0,
  sentToMeta: 0,
  losses: 0,
  impressions: 0,
  clicks: 0,
  metaResults: 0,
  metaPurch: 0,
};

export function totalsOf(list: Creative[], adsMeta: AdsMeta): Totals {
  return list.reduce<Totals>(
    (acc, c) => {
      const m = adsMeta[c.creative];
      acc.spendKzt += c.spendKzt;
      acc.spendUsd += c.spendUsd;
      acc.revenue += c.revenue;
      acc.purchases += c.purchases;
      acc.dialogs += c.dialogs;
      acc.qual += c.qual;
      acc.measure += c.measure;
      acc.sentToMeta += c.sentToMeta;
      acc.losses += lossesOf(c);
      acc.impressions += m?.impressions ?? 0;
      acc.clicks += m?.clicks ?? 0;
      acc.metaResults += m?.metaResults ?? 0;
      acc.metaPurch += m?.metaPurch ?? 0;
      return acc;
    },
    { ...emptyTotals }
  );
}

/**
 * Объявления выбранных рекламных аккаунтов. Если выбор пуст — показываем всё,
 * иначе экран креативов оказывался бы пустым и непонятным.
 */
export function visibleCreatives(
  creatives: Creative[],
  accounts: AdAccount[],
  selectedIds: string[]
): Creative[] {
  const names = accounts.filter((a) => selectedIds.includes(a.id)).map((a) => a.name);
  const visible = creatives.filter((c) => names.includes(c.account));
  return visible.length ? visible : creatives;
}

/** Расход по каждому аккаунту — для строки «расход за 30 дней» в интеграциях. */
export function spendByAccount(creatives: Creative[]): Record<string, number> {
  return creatives.reduce<Record<string, number>>((acc, c) => {
    acc[c.account] = (acc[c.account] ?? 0) + c.spendKzt;
    return acc;
  }, {});
}

/** Статус доставки с учётом локально переключённых тумблеров. */
export function statusOf(
  c: Creative,
  off: Record<string, boolean>,
  adsMeta: AdsMeta
): DeliveryStatus {
  if (off[c.creative]) return 'off';
  return adsMeta[c.creative]?.status ?? 'active';
}

/** Статус группы: всё выключено → off, есть обучение → learning, и так далее. */
export function groupStatus(
  items: Creative[],
  off: Record<string, boolean>,
  adsMeta: AdsMeta
): DeliveryStatus {
  const statuses = items.map((i) => statusOf(i, off, adsMeta));
  if (statuses.every((s) => s === 'off')) return 'off';
  if (statuses.some((s) => s === 'learning')) return 'learning';
  if (statuses.some((s) => s === 'review')) return 'review';
  return 'active';
}

/** Группировка с сохранением порядка первого появления ключа. */
export function groupBy<T>(list: T[], key: (item: T) => string): { key: string; items: T[] }[] {
  const order: string[] = [];
  const map: Record<string, T[]> = {};
  list.forEach((item) => {
    const k = key(item);
    if (!map[k]) {
      map[k] = [];
      order.push(k);
    }
    map[k].push(item);
  });
  return order.map((k) => ({ key: k, items: map[k] }));
}
