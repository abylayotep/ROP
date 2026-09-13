import { useEffect, useState } from 'react';
import * as api from '@/api';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import type { Product, Promotion, PromotionItemInput } from '@/types';
import { formatPrice } from './ProductsTab';

/* ── Time in the agent's zone ────────────────────────────────────────────────
 * The owner sets «до 30 сентября, 23:59» in the shop's zone, whatever zone the browser is in,
 * so the conversions go through `Intl` with the agent's `timezone`, never the local clock. */

function zoneParts(at: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}

/** A zone the browser knows, or UTC — an unknown one would throw on every render. */
export function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant as a `datetime-local` value on the agent's wall clock: `2026-09-30T23:59`. */
export function toZoneInput(iso: string, timeZone: string): string {
  const p = zoneParts(new Date(iso), safeZone(timeZone));
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}`;
}

/**
 * A `datetime-local` value read on the agent's wall clock, as an ISO instant, or null when it
 * is not a date. The zone's offset is found by asking what the wall clock shows at a first
 * guess and correcting by the difference — twice, so a guess on the wrong side of a DST change
 * still lands.
 */
export function fromZoneInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  const zone = safeZone(timeZone);
  let guess = wanted;
  for (let i = 0; i < 2; i += 1) {
    const p = zoneParts(new Date(guess), zone);
    const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!);
    guess += wanted - shown;
  }
  return new Date(guess).toISOString();
}

/** «30 сентября 2026, 23:59» on the agent's clock. */
export function formatEnd(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: safeZone(timeZone), day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}

export type PromotionStatus = 'active' | 'off' | 'expired';

/** What the badge says. A promotion past its date is «Истекла» whether or not it was switched off by it. */
export function promotionStatus(promotion: Pick<Promotion, 'effective' | 'endsAt'>, now = Date.now()): PromotionStatus {
  if (promotion.effective) return 'active';
  if (promotion.endsAt !== null && new Date(promotion.endsAt).getTime() <= now) return 'expired';
  return 'off';
}

const STATUS_LABEL: Record<PromotionStatus, string> = { active: 'Активна', off: 'Выключена', expired: 'Истекла' };

/** Picked variants and their typed prices, as the server wants them, or the first thing wrong. */
export function itemsFromPicks(picks: Record<string, string>):
  { ok: true; items: PromotionItemInput[] } | { ok: false; message: string } {
  const items: PromotionItemInput[] = [];
  for (const [variantId, raw] of Object.entries(picks)) {
    const digits = raw.replace(/\s/g, '');
    if (!/^\d{1,10}$/.test(digits) || Number(digits) > 1_000_000_000) {
      return { ok: false, message: 'Укажите цену по акции целым числом для каждого отмеченного варианта' };
    }
    items.push({ variantId, promoPrice: Number(digits) });
  }
  return { ok: true, items };
}

/** «1 позиция», «3 позиции», «11 позиций». */
export function positions(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? 'позиций' : ones === 1 ? 'позиция' : ones >= 2 && ones <= 4 ? 'позиции' : 'позиций';
  return `${n} ${word}`;
}

const NEW = 'new';

/**
 * «Акции»: promotion presets at the top of «Товары», because a promotion is a price on those
 * same variants. The owner prepares several and switches one on; while it is on, the agent
 * quotes its prices for the variants in it and nothing else changes. Members see it read-only.
 */
export function PromotionsSection({ agentId, owner, currency, timezone, products }: {
  agentId: string;
  owner: boolean;
  currency: string;
  timezone: string;
  products: Product[];
}) {
  const toast = useToast();
  const query = useApi<Promotion[]>((signal) => api.listPromotions(agentId, signal), [agentId]);
  const [changed, setChanged] = useState<Promotion[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = changed ?? query.data;

  if (items === undefined) {
    return query.error !== undefined
      ? <ErrorState error={query.error} onRetry={query.reload} compact />
      : <Skeleton height={80} />;
  }

  const current = selected === NEW ? null : items.find((promotion) => promotion.id === selected) ?? null;
  const editorOpen = selected === NEW || current !== null;

  /** A switch changes two rows: the reloaded list is the only view that has both right. */
  async function toggle(promotion: Promotion) {
    if (!owner || busy !== null) return;
    setBusy(promotion.id);
    try {
      const turningOn = !promotion.active;
      if (turningOn) await api.activatePromotion(agentId, promotion.id);
      else await api.deactivatePromotion(agentId, promotion.id);
      setChanged(await api.listPromotions(agentId));
      toast.ok(turningOn ? `Акция «${promotion.name}» включена` : `Акция «${promotion.name}» выключена`);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="promotions" aria-labelledby="promotions-title">
      <div className="promotions__head">
        <div>
          <h2 id="promotions-title" className="promotions__title">Акции</h2>
          <p className="training-tab__intro">
            Подготовьте акции заранее и включайте одной кнопкой. Пока акция включена, агент называет цены по акции
            для её товаров и не добавляет к ним другие скидки.
          </p>
        </div>
        {owner && <button type="button" className="btn" onClick={() => setSelected(NEW)}>Новая акция</button>}
      </div>

      {items.length === 0 ? (
        <p className="products-editor__note">
          {owner ? 'Акций пока нет.' : 'Владелец ещё не подготовил акции.'}
        </p>
      ) : (
        <ul className="promotions-list">
          {items.map((promotion) => {
            const status = promotionStatus(promotion);
            return (
              <li key={promotion.id} className="promotions-row" aria-current={promotion.id === selected}>
                <button type="button" className="promotions-row__open" onClick={() => setSelected(promotion.id)}>
                  <span className="promotions-row__name">{promotion.name}</span>
                  <span className="promotions-row__meta">
                    {promotion.endsAt === null ? 'Без срока' : `до ${formatEnd(promotion.endsAt, timezone)}`}
                    {' · '}{positions(promotion.items.length)}
                  </span>
                </button>
                <span className={`promotions-badge promotions-badge--${status}`}>{STATUS_LABEL[status]}</span>
                {owner && (
                  <button type="button" className={promotion.active ? 'btn-sm' : 'btn-sm btn-accent'}
                    disabled={busy !== null || (!promotion.active && status === 'expired')}
                    onClick={() => void toggle(promotion)}>
                    {busy === promotion.id ? '…' : promotion.active ? 'Выключить' : 'Включить'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editorOpen && (
        <PromotionEditor
          key={selected}
          agentId={agentId}
          promotion={current}
          owner={owner}
          currency={currency}
          timezone={timezone}
          products={products}
          onSaved={(saved) => {
            const exists = items.some((item) => item.id === saved.id);
            setChanged(exists ? items.map((item) => (item.id === saved.id ? saved : item)) : [...items, saved]);
            setSelected(saved.id);
          }}
          onDeleted={(id) => {
            setChanged(items.filter((item) => item.id !== id));
            setSelected(null);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

export function PromotionEditor({ agentId, promotion, owner, currency, timezone, products, onSaved, onDeleted, onClose }: {
  agentId: string;
  promotion: Promotion | null;
  owner: boolean;
  currency: string;
  timezone: string;
  products: Product[];
  onSaved: (promotion: Promotion) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(promotion?.name ?? '');
  const [description, setDescription] = useState(promotion?.description ?? '');
  const [ends, setEnds] = useState(promotion?.endsAt ? toZoneInput(promotion.endsAt, timezone) : '');
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries((promotion?.items ?? []).map((item) => [item.variantId, String(item.promoPrice)])));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const readOnly = !owner;

  useEffect(() => setProblem(null), [name, ends, picks]);

  // Only variants the catalog still has: a removed size left the promotion on the server too.
  const known = new Set(products.flatMap((product) => product.variants.map((variant) => variant.id)));

  async function save() {
    if (readOnly || busy) return;
    if (name.trim() === '') { setProblem('Укажите название акции'); return; }
    let endsAt: string | null = null;
    if (ends !== '') {
      endsAt = fromZoneInput(ends, timezone);
      if (endsAt === null) { setProblem('Не удалось разобрать дату окончания'); return; }
    }
    const table = itemsFromPicks(Object.fromEntries(Object.entries(picks).filter(([id]) => known.has(id))));
    if (!table.ok) { setProblem(table.message); return; }
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim(), endsAt, items: table.items };
      const saved = promotion === null
        ? await api.createPromotion(agentId, body)
        : await api.updatePromotion(agentId, promotion.id, body);
      onSaved(saved);
      toast.ok(promotion === null ? 'Акция добавлена' : 'Акция сохранена');
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (readOnly || busy || promotion === null) return;
    if (!window.confirm(`Удалить акцию «${promotion.name}»?`)) return;
    setBusy(true);
    try {
      await api.deletePromotion(agentId, promotion.id);
      onDeleted(promotion.id);
      toast.ok('Акция удалена');
    } catch (error) {
      toast.fail(error);
      setBusy(false);
    }
  }

  const pick = (variantId: string, on: boolean) => {
    const next = { ...picks };
    if (on) next[variantId] = picks[variantId] ?? '';
    else delete next[variantId];
    setPicks(next);
  };

  return (
    <div className="products-editor promotions-editor">
      <div className="knowledge-panel-head">
        <div>
          <p className="knowledge-kicker">{promotion === null ? 'Новая акция' : 'Акция'}</p>
          <h3 className="promotions__title">{promotion?.name || 'Без названия'}</h3>
        </div>
        <button type="button" className="btn-link" onClick={onClose}>Закрыть</button>
      </div>

      <form className="products-editor__form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="products-editor__label" htmlFor="promotion-name">Название</label>
        <input id="promotion-name" className="knowledge-control" value={name} maxLength={120} disabled={readOnly || busy}
          placeholder="Например, 6990" onChange={(event) => setName(event.target.value)} />

        <label className="products-editor__label" htmlFor="promotion-description">Дополнительные условия</label>
        <textarea id="promotion-description" className="knowledge-control" rows={2} value={description} maxLength={2000}
          disabled={readOnly || busy} onChange={(event) => setDescription(event.target.value)}
          placeholder="То, что агент может упомянуть, например «упаковка в подарок»" />

        <label className="products-editor__label" htmlFor="promotion-ends">Действует до</label>
        <input id="promotion-ends" type="datetime-local" className="knowledge-control promotions-editor__ends" value={ends}
          disabled={readOnly || busy} onChange={(event) => setEnds(event.target.value)} />
        <p className="products-editor__note">
          Время по часовому поясу агента ({safeZone(timezone)}). Оставьте пустым — акция действует, пока её не выключат.
        </p>

        <fieldset className="promotions-picker" disabled={readOnly || busy}>
          <legend className="products-editor__label">Товары и цены по акции</legend>
          {products.every((product) => product.variants.length === 0) ? (
            <p className="products-editor__note">В каталоге нет товаров с ценами — сначала добавьте товар ниже.</p>
          ) : products.filter((product) => product.variants.length > 0).map((product) => (
            <div key={product.id} className="promotions-picker__product">
              <p className="promotions-picker__name">{product.name}{!product.active && ' · скрыт от агента'}</p>
              {product.variants.map((variant) => {
                const checked = variant.id in picks;
                const label = variant.label || 'Цена';
                return (
                  <div key={variant.id} className="promotions-picker__row">
                    <label className="products-editor__check">
                      <input type="checkbox" checked={checked} onChange={(event) => pick(variant.id, event.target.checked)} />
                      {label}
                    </label>
                    <span className="promotions-picker__regular">{formatPrice(variant.price, currency)}</span>
                    <input className="knowledge-control" inputMode="numeric" placeholder="Цена по акции" disabled={!checked}
                      aria-label={`Цена по акции: ${product.name}, ${label}`} value={picks[variant.id] ?? ''}
                      onChange={(event) => setPicks({ ...picks, [variant.id]: event.target.value })} />
                  </div>
                );
              })}
            </div>
          ))}
        </fieldset>

        {problem && <p className="products-editor__problem" role="alert">{problem}</p>}
        {owner && (
          <div className="products-editor__actions">
            <button type="submit" className="btn-accent" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            {promotion !== null && <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>Удалить акцию</button>}
          </div>
        )}
      </form>
    </div>
  );
}
