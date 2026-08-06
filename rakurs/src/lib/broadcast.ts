import { num, plural } from '@/lib/format';
import type { BroadcastSegment, BroadcastTemplate, TemplateCategory } from '@/types';

export interface PreflightCheck {
  ok: boolean;
  label: string;
  meta: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  failed: number;
  blocked: boolean;
  willSend: number;
  eligible: number;
  remaining: number;
  overLimit: number;
  excluded: { k: string; v: string; fg: string }[];
}

export interface PreflightInput {
  segments: BroadcastSegment[];
  templates: BroadcastTemplate[];
  /** Лимиты портфеля из WhatsApp Manager. */
  tierLimit: number;
  sentToday: number;
  blockRate: number;

  selSeg: string[];
  tplCat: TemplateCategory;
  selTpl: string;
  pace: 'ramp' | 'even' | 'blast';
  win: string;
}

/**
 * Предполётная проверка рассылки. Каждый пункт — правило Meta, за нарушение
 * которого блокируют номер, поэтому запуск закрыт, пока хоть один красный.
 *
 * Те же правила обязаны стоять и на сервере: кнопка в интерфейсе — не защита.
 *
 * Число получателей = согласившиеся − отписавшиеся − достигшие суточного лимита
 * − номера +1 (для marketing), затем обрезается остатком суточного лимита.
 */
export function preflight(input: PreflightInput): PreflightResult {
  const { segments, templates, tierLimit, sentToday, blockRate, selSeg, tplCat, selTpl, pace, win } =
    input;

  const chosen = segments.filter((s) => selSeg.includes(s.id));
  const hasForbidden = chosen.some((s) => s.forbidden);
  const forbiddenTotal = chosen
    .filter((s) => s.forbidden)
    .reduce((a, s) => a + s.total, 0);
  const sumBy = (k: 'optIn' | 'stopped' | 'capped' | 'us' | 'total') =>
    chosen.reduce((a, s) => a + s[k], 0);

  const poolOptIn = sumBy('optIn');
  const exStopped = sumBy('stopped');
  const exCapped = sumBy('capped');
  // Номера +1 отсекаются только для marketing: utility по ним проходит.
  const exUs = tplCat === 'marketing' ? sumBy('us') : 0;
  const exNoOptIn = sumBy('total') - poolOptIn;

  const remaining = Math.max(0, tierLimit - sentToday);
  const eligible = Math.max(0, poolOptIn - exStopped - exCapped - exUs);
  const willSend = Math.min(eligible, remaining);
  const overLimit = eligible > remaining;

  const tpl = templates.find((t) => t.id === selTpl) ?? templates[0];
  const winOk = win !== '00–24';
  const blockPercent = (blockRate * 100).toFixed(1).replace('.', ',');

  const checks: PreflightCheck[] = [
    hasForbidden
      ? {
          ok: false,
          label: 'Есть согласие на переписку',
          meta: `Выбран загруженный список без согласия — ${num(forbiddenTotal)} номеров. Рассылка по такой базе блокирует номер почти сразу. Снимите этот сегмент.`,
        }
      : {
          ok: true,
          label: 'Есть согласие на переписку',
          meta: `Все ${num(poolOptIn)} получателей сами писали вам первыми. Без согласия — ${num(exNoOptIn)}, они исключены.`,
        },
    {
      ok: true,
      label: 'Отписавшиеся исключены',
      meta: `${exStopped} номеров ответили СТОП ранее. Ракурс блокирует отправку им на уровне системы.`,
    },
    {
      ok: true,
      label: 'Частотный лимит Meta соблюдён',
      meta: `${exCapped} человек уже получили сегодня 2 маркетинговых сообщения от других компаний. Им отправка перенесена на завтра — иначе ошибка 131049.`,
    },
    {
      ok: tplCat === 'utility' || !tpl?.warn,
      label: 'Категория совпадает с текстом',
      meta: tpl?.warn
        ? 'Текст выглядит как массовое промо со срочностью. Такие шаблоны получают жалобы и роняют качество номера — перепишите под конкретного клиента.'
        : tplCat === 'marketing'
          ? 'Marketing-шаблон с персональным обращением и отпиской.'
          : 'Utility-шаблон отправляется только по активным сделкам из CRM.',
    },
    {
      ok: true,
      label: 'В шаблоне есть отписка',
      meta: 'Строка про СТОП добавляется автоматически ко всем marketing-шаблонам. Ответ СТОП сразу заносится в исключения.',
    },
    {
      ok: !overLimit,
      label: 'Не превышаем суточный лимит',
      meta: overLimit
        ? `Получателей ${num(eligible)}, а до лимита осталось ${num(remaining)}. Остаток уйдёт завтра автоматически.`
        : `Лимит портфеля ${num(tierLimit)} в сутки, сегодня использовано ${num(sentToday)}. Запас есть.`,
    },
    {
      ok: pace !== 'blast',
      label: 'Темп без скачков',
      meta:
        pace === 'blast'
          ? 'Отправка всей базы в одну минуту — типичный признак спам-рассылки. Выберите плавный разгон.'
          : 'Объём растёт постепенно, Meta видит естественный рост.',
    },
    {
      ok: winOk,
      label: 'Окно отправки',
      meta: winOk
        ? `Отправка с ${win.split('–')[0]}:00 до ${win.split('–')[1]}:00 по времени клиента.`
        : 'Круглосуточная отправка даёт ночные сообщения — жалобы и блокировки.',
    },
    {
      ok: blockRate < 0.02,
      label: 'Качество номера зелёное',
      meta: `Блокировок ${blockPercent}% за 30 дней. Порог, после которого Meta снижает лимиты — 2%.`,
    },
  ];

  const failed = checks.filter((c) => !c.ok).length;

  return {
    checks,
    failed,
    blocked: failed > 0,
    willSend,
    eligible,
    remaining,
    overLimit: overLimit ? eligible - remaining : 0,
    excluded: [
      {
        k: 'Без согласия',
        v: `−${num(exNoOptIn)}`,
        fg: exNoOptIn ? 'var(--danger)' : 'var(--text-4)',
      },
      { k: 'Отписались (СТОП)', v: `−${exStopped}`, fg: 'var(--text-4)' },
      { k: 'Лимит 2 в сутки', v: `−${exCapped}`, fg: 'var(--warn)' },
      { k: 'Номера +1 (США)', v: `−${exUs}`, fg: 'var(--text-4)' },
      {
        k: 'Перенесено на завтра',
        v: overLimit ? `−${num(eligible - remaining)}` : '0',
        fg: overLimit ? 'var(--warn)' : 'var(--text-4)',
      },
    ],
  };
}

export function preflightLabel(failed: number): string {
  return failed > 0
    ? `${failed} ${plural(failed, 'проблема', 'проблемы', 'проблем')}`
    : 'Можно отправлять';
}
