import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, Promotion } from '@/types';

const fixture = vi.hoisted(() => ({
  data: undefined as Promotion[] | undefined,
  error: undefined as unknown,
  reload: vi.fn(),
}));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ ...fixture, loading: false }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: vi.fn(), fail: vi.fn() }) }));
import {
  formatEnd,
  fromZoneInput,
  itemsFromPicks,
  positions,
  PromotionEditor,
  PromotionsSection,
  promotionStatus,
  toZoneInput,
} from './PromotionsSection';

const r42: Product = {
  id: 'product-1', name: 'Корпус R42', description: '', position: 0, active: true,
  variants: [
    { id: 'v40', label: '40 мм', price: 9990, position: 0 },
    { id: 'v30', label: '30 мм', price: 8990, position: 1 },
  ],
  photos: [], createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
};

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: 'promo-1', name: '6990', description: 'Упаковка в подарок', active: true, effective: true,
  endsAt: '2099-09-30T14:59:00.000Z', position: 0,
  items: [{ variantId: 'v40', productId: 'product-1', productName: 'Корпус R42', variantLabel: '40 мм', regularPrice: 9990, promoPrice: 6990 }],
  createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', ...over,
});

const section = (owner: boolean) => renderToStaticMarkup(createElement(PromotionsSection, {
  agentId: 'agent-1', owner, currency: 'KZT', timezone: 'Asia/Tokyo', products: [r42],
}));
const editor = (owner: boolean, promotion: Promotion | null = promo()) => renderToStaticMarkup(createElement(PromotionEditor, {
  agentId: 'agent-1', promotion, owner, currency: 'KZT', timezone: 'Asia/Tokyo', products: [r42],
  onSaved: () => undefined, onDeleted: () => undefined, onClose: () => undefined,
}));

beforeEach(() => {
  fixture.data = [
    promo(),
    promo({ id: 'promo-2', name: 'Осень', active: false, effective: false, endsAt: null, items: [] }),
    promo({ id: 'promo-3', name: 'Лето', active: false, effective: false, endsAt: '2026-08-31T14:59:00.000Z' }),
  ];
  fixture.error = undefined;
});

describe('PromotionsSection', () => {
  it('lists presets with a status badge, the end date in the agent zone and a switch for the owner', () => {
    const html = section(true);
    expect(html).toContain('Акции');
    expect(html).toContain('Новая акция');
    expect(html).toContain('Активна');
    expect(html).toContain('Выключена');
    expect(html).toContain('Истекла');
    expect(html).toContain('до 30 сентября 2099, 23:59');
    expect(html).toContain('Без срока');
    expect(html).toContain('Выключить');
    expect(html).toContain('Включить');
  });

  it('shows members the presets without switches or the add button', () => {
    const html = section(false);
    expect(html).toContain('Активна');
    expect(html).not.toContain('Новая акция');
    expect(html).not.toContain('Включить');
    expect(html).not.toContain('Выключить');
  });

  it('says there are none in words that fit the reader', () => {
    fixture.data = [];
    expect(section(true)).toContain('Акций пока нет');
    expect(section(false)).toContain('Владелец ещё не подготовил акции');
  });

  it('gives the owner a picker of variants with the regular price beside the promotional one', () => {
    const html = editor(true);
    expect(html).toContain('value="6990"');
    expect(html).toContain('Корпус R42');
    expect(html).toContain('9 990 ₸');
    expect(html).toContain('8 990 ₸');
    expect(html).toContain('value="2099-09-30T23:59"');
    expect(html).toContain('Asia/Tokyo');
    expect(html).toContain('Сохранить');
    expect(html).toContain('Удалить акцию');
  });

  it('keeps the editor read-only for members', () => {
    const html = editor(false);
    expect(html).toContain('value="6990"');
    expect(html).not.toContain('Сохранить');
    expect(html).toContain('disabled=""');
  });
});

describe('promotion helpers', () => {
  it('names the status: in effect, switched off, or past its date', () => {
    const now = Date.parse('2026-09-14T00:00:00Z');
    expect(promotionStatus({ effective: true, endsAt: null }, now)).toBe('active');
    expect(promotionStatus({ effective: false, endsAt: null }, now)).toBe('off');
    expect(promotionStatus({ effective: false, endsAt: '2026-09-01T00:00:00Z' }, now)).toBe('expired');
    expect(promotionStatus({ effective: false, endsAt: '2026-10-01T00:00:00Z' }, now)).toBe('off');
  });

  it("converts between the agent's wall clock and an instant, whatever the browser zone", () => {
    expect(fromZoneInput('2026-09-30T23:59', 'Asia/Tokyo')).toBe('2026-09-30T14:59:00.000Z');
    expect(toZoneInput('2026-09-30T14:59:00.000Z', 'Asia/Tokyo')).toBe('2026-09-30T23:59');
    expect(fromZoneInput('2026-09-30T23:59', 'UTC')).toBe('2026-09-30T23:59:00.000Z');
    // Across a DST change: New York is UTC-4 in July and UTC-5 in December.
    expect(fromZoneInput('2026-07-01T12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
    expect(fromZoneInput('2026-12-01T12:00', 'America/New_York')).toBe('2026-12-01T17:00:00.000Z');
    expect(fromZoneInput('завтра', 'Asia/Tokyo')).toBeNull();
    expect(formatEnd('2026-12-31T20:30:00Z', 'Asia/Tokyo')).toBe('1 января 2027, 05:30');
    expect(formatEnd('2026-12-31T20:30:00Z', 'Not/AZone')).toBe('31 декабря 2026, 20:30');
  });

  it('reads picked prices and names a missing one', () => {
    expect(itemsFromPicks({ v40: '6 990' })).toEqual({ ok: true, items: [{ variantId: 'v40', promoPrice: 6990 }] });
    expect(itemsFromPicks({ v40: '' })).toEqual({ ok: false, message: 'Укажите цену по акции целым числом для каждого отмеченного варианта' });
  });

  it('agrees the word with the count', () => {
    expect([1, 3, 5, 11, 21, 22].map(positions)).toEqual(['1 позиция', '3 позиции', '5 позиций', '11 позиций', '21 позиция', '22 позиции']);
  });
});
