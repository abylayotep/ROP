import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@/types';

const fixture = vi.hoisted(() => ({
  data: undefined as Product[] | undefined,
  error: undefined as unknown,
  reload: vi.fn(),
}));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ ...fixture, loading: false }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: vi.fn(), fail: vi.fn() }) }));
import {
  PHOTO_MAX_BYTES,
  ProductEditor,
  ProductsTab,
  photoProblem,
  priceRange,
  variantsFromRows,
} from './ProductsTab';

const door: Product = {
  id: 'product-1', name: 'Дверь «Гранит»', description: 'Металлическая', position: 0, active: true,
  variants: [
    { id: 'v1', label: '40 мм', price: 85000, position: 0 },
    { id: 'v2', label: '30 мм', price: 72000, position: 1 },
  ],
  photos: [{ id: 'photo-1', mime: 'image/jpeg', sizeBytes: 10, filename: 'door.jpg', caption: 'Вид спереди',
    position: 0, createdAt: '2026-09-14T00:00:00.000Z' }],
  createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
};

const tab = (owner: boolean) => renderToStaticMarkup(createElement(ProductsTab, { agentId: 'agent-1', owner, currency: 'KZT' }));
const editor = (owner: boolean, product: Product | null = door) => renderToStaticMarkup(createElement(ProductEditor, {
  agentId: 'agent-1', product, owner, onSaved: () => undefined, onClose: () => undefined, onDeleted: () => undefined,
}));

beforeEach(() => {
  fixture.data = [door, { ...door, id: 'product-2', name: 'Ручка', active: false, variants: [], photos: [] }];
  fixture.error = undefined;
});

describe('ProductsTab', () => {
  it('lists cards with a thumbnail, the name and the price range, and offers the owner to add one', () => {
    const html = tab(true);
    expect(html).toContain('Дверь «Гранит»');
    expect(html).toContain('от 72 000 до 85 000 ₸');
    expect(html).toContain('/agents/agent-1/products/product-1/photos/photo-1/file');
    expect(html).toContain('Нет фото');
    expect(html).toContain('Цена не указана');
    expect(html).toContain('Скрыт от агента');
    expect(html).toContain('Добавить товар');
  });

  it('shows members the catalog without the add button', () => {
    expect(tab(false)).not.toContain('Добавить товар');
  });

  it('says the catalog is empty in words that fit the reader', () => {
    fixture.data = [];
    expect(tab(true)).toContain('Добавьте товар с ценой и фото');
    expect(tab(false)).toContain('Владелец ещё не добавил товары');
  });

  it('gives the owner the variants table, photo tools and the upload area', () => {
    const html = editor(true);
    expect(html).toContain('Размеры и цены');
    expect(html).toContain('value="40 мм"');
    expect(html).toContain('value="85000"');
    expect(html).toContain('+ Добавить вариант');
    expect(html).toContain('Фото · 1 из 10');
    expect(html).toContain('aria-label="Удалить фото"');
    expect(html).toContain('выберите файлы');
    expect(html).toContain('Удалить товар');
  });

  it('keeps the editor read-only for members', () => {
    const html = editor(false);
    expect(html).toContain('value="40 мм"');
    expect(html).not.toContain('Сохранить');
    expect(html).not.toContain('выберите файлы');
    expect(html).not.toContain('aria-label="Удалить фото"');
    expect(html).toContain('disabled=""');
  });

  it('asks for photos only after a new product is saved', () => {
    expect(editor(true, null)).toContain('Фото можно добавить после сохранения товара');
  });
});

describe('product helpers', () => {
  it('formats one price, a range and none', () => {
    expect(priceRange([{ price: 1500 }], 'KZT')).toBe('1 500 ₸');
    expect(priceRange([{ price: 1500 }, { price: 900 }], 'USD')).toBe('от 900 до 1 500 USD');
    expect(priceRange([], 'KZT')).toBe('Цена не указана');
  });

  it('reads the variants table, dropping empty rows and naming a bad price', () => {
    expect(variantsFromRows([{ label: '40 мм', price: '85 000' }, { label: '', price: '' }]))
      .toEqual({ ok: true, variants: [{ label: '40 мм', price: 85000 }] });
    expect(variantsFromRows([{ label: '', price: '1500' }])).toEqual({ ok: true, variants: [{ label: '', price: 1500 }] });
    expect(variantsFromRows([{ label: '30 мм', price: '12.5' }]))
      .toEqual({ ok: false, message: 'Укажите цену целым числом для «30 мм»' });
  });

  it('refuses a wrong type, a big file and an eleventh photo before uploading', () => {
    expect(photoProblem({ type: 'image/jpeg', size: 100 }, 0)).toBeNull();
    expect(photoProblem({ type: 'image/heic', size: 100 }, 0)).toBe('Подойдут только фото JPEG, PNG или WebP');
    expect(photoProblem({ type: 'image/png', size: PHOTO_MAX_BYTES + 1 }, 0)).toBe('Фото больше 5 МБ');
    expect(photoProblem({ type: 'image/png', size: 100 }, 10)).toBe('У товара уже 10 фото');
  });
});
