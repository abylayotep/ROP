import type { DeliveryStatus, DialogStatus, Tone as ToneName, Verdict } from '@/types';

/**
 * Цветовые тона. Все значения — CSS-переменные или полупрозрачные наложения,
 * поэтому одинаково работают в обеих темах.
 */

export interface VerdictTone {
  fg: string;
  bg: string;
  soft: string;
  bd: string;
}

export function verdictTone(v: Verdict): VerdictTone {
  if (v === 'bad')
    return {
      fg: 'var(--danger)',
      bg: 'rgba(216,87,76,0.16)',
      soft: 'rgba(216,87,76,0.08)',
      bd: 'rgba(216,87,76,0.28)',
    };
  if (v === 'warn')
    return {
      fg: 'var(--warn)',
      bg: 'rgba(217,161,60,0.16)',
      soft: 'rgba(217,161,60,0.07)',
      bd: 'rgba(217,161,60,0.26)',
    };
  return {
    fg: 'var(--accent)',
    bg: 'rgba(13,150,104,0.16)',
    soft: 'rgba(13,150,104,0.08)',
    bd: 'rgba(13,150,104,0.3)',
  };
}

export function statusStyle(s: DialogStatus): { bg: string; fg: string } {
  if (s === 'Упустили') return { bg: 'rgba(216,87,76,0.14)', fg: 'var(--danger)' };
  if (s === 'В работе') return { bg: 'rgba(217,161,60,0.14)', fg: 'var(--warn)' };
  return { bg: 'rgba(13,150,104,0.16)', fg: 'var(--accent)' };
}

/** Оценка AI: ≥80 — зелёная, ≥65 — жёлтая, ниже — красная. */
export function scoreColor(n: number): string {
  return n >= 80 ? 'var(--accent)' : n >= 65 ? 'var(--warn)' : 'var(--danger-2)';
}

export function deliveryStyle(s: DeliveryStatus): { label: string; dot: string; fg: string } {
  if (s === 'off') return { label: 'Выключена', dot: 'var(--text-faint)', fg: 'var(--text-muted)' };
  if (s === 'learning') return { label: 'Обучение', dot: 'var(--warn)', fg: 'var(--warn)' };
  if (s === 'review') return { label: 'На проверке', dot: 'var(--warn)', fg: 'var(--warn)' };
  return { label: 'Активна', dot: 'var(--accent-2)', fg: 'var(--accent)' };
}

/** Пять ступеней интенсивности ячейки тепловой карты. */
export function heatColor(v: number, max: number): { bg: string; bd: string } {
  if (v === 0) return { bg: 'var(--heat0)', bd: 'var(--heat0-bd)' };
  const r = v / max;
  if (r > 0.78) return { bg: 'var(--accent-2)', bd: 'var(--accent-3)' };
  if (r > 0.55) return { bg: 'rgba(13,150,104,0.72)', bd: 'rgba(13,150,104,0.85)' };
  if (r > 0.32) return { bg: 'rgba(13,150,104,0.46)', bd: 'rgba(13,150,104,0.6)' };
  return { bg: 'rgba(13,150,104,0.22)', bd: 'rgba(13,150,104,0.36)' };
}

/** ROAS: от 3 — зелёный, от 1 — жёлтый, ниже — красный. */
export function roasColor(roas: number): string {
  return roas >= 3 ? 'var(--accent)' : roas >= 1 ? 'var(--warn)' : 'var(--danger)';
}

/** Цвет для тона, который прислал бэкенд. */
export function toneColor(t: ToneName): string {
  if (t === 'danger') return 'var(--danger-2)';
  if (t === 'warn') return 'var(--warn)';
  if (t === 'ok') return 'var(--accent-2)';
  return 'var(--text-4)';
}

/** Цвет текста для тона — там, где красится значение, а не полоска. */
export function toneText(t: ToneName): string {
  if (t === 'danger') return 'var(--danger)';
  if (t === 'warn') return 'var(--warn)';
  if (t === 'ok') return 'var(--accent)';
  return 'var(--text)';
}

/**
 * Цвет конверсии продавца относительно среднего по отделу и цвет времени ответа
 * по абсолютной шкале. Раньше это была таблица по инициалам — она работала
 * только на одном наборе данных.
 */
export function sellerConvColor(convPct: number, avgPct: number): string {
  if (!avgPct) return 'var(--text)';
  const ratio = convPct / avgPct;
  if (ratio >= 1.2) return 'var(--accent)';
  if (ratio >= 0.9) return 'var(--text)';
  if (ratio >= 0.75) return 'var(--warn)';
  return 'var(--danger)';
}

/** Скорость ответа: до 5 минут — хорошо, до 15 — норма, до 30 — тревожно. */
export function replyColor(minutes: number): string {
  if (minutes <= 5) return 'var(--accent)';
  if (minutes <= 15) return 'var(--text)';
  if (minutes <= 30) return 'var(--warn)';
  return 'var(--danger)';
}
