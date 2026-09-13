import { useEffect, useState, type DragEvent } from 'react';
import * as api from '@/api';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { PromotionsSection } from './PromotionsSection';
import type { Product, ProductVariant, ProductVariantInput } from '@/types';

/** Mirrors `server/src/lib/catalog/products.ts`: checked here too, so a wrong file fails before the upload. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTOS_PER_PRODUCT = 10;
export const VARIANTS_PER_PRODUCT = 20;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** A whole price as the cabinet writes it everywhere: `85 000 ₸`. */
export function formatPrice(price: number, currency: string): string {
  const grouped = String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} ${currency === 'KZT' ? '₸' : currency}`;
}

/** «от 72 000 до 85 000 ₸», one price, or «Цена не указана». */
export function priceRange(variants: Pick<ProductVariant, 'price'>[], currency: string): string {
  if (variants.length === 0) return 'Цена не указана';
  const prices = variants.map((variant) => variant.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (low === high) return formatPrice(low, currency);
  return `от ${formatPrice(low, currency).replace(/ \S+$/, '')} до ${formatPrice(high, currency)}`;
}

export interface VariantRow {
  /** The saved variant this row edits; absent on a row the owner just added. */
  id?: string;
  label: string;
  price: string;
}

/** The table as the server wants it, or the first thing wrong with it. Empty rows are dropped. */
export function variantsFromRows(rows: VariantRow[]):
  { ok: true; variants: ProductVariantInput[] } | { ok: false; message: string } {
  const variants: ProductVariantInput[] = [];
  for (const row of rows) {
    const label = row.label.trim();
    const digits = row.price.replace(/\s/g, '');
    if (label === '' && digits === '') continue;
    if (!/^\d{1,10}$/.test(digits) || Number(digits) > 1_000_000_000) {
      return { ok: false, message: label ? `Укажите цену целым числом для «${label}»` : 'Укажите цену целым числом' };
    }
    variants.push({ ...(row.id === undefined ? {} : { id: row.id }), label, price: Number(digits) });
  }
  if (variants.length > VARIANTS_PER_PRODUCT) {
    return { ok: false, message: `Не больше ${VARIANTS_PER_PRODUCT} вариантов у товара` };
  }
  return { ok: true, variants };
}

/** Why this file cannot be a product photo, or null when it can. */
export function photoProblem(file: { type: string; size: number }, existing: number): string | null {
  if (existing >= PHOTOS_PER_PRODUCT) return `У товара уже ${PHOTOS_PER_PRODUCT} фото`;
  if (!PHOTO_TYPES.includes(file.type)) return 'Подойдут только фото JPEG, PNG или WebP';
  if (file.size > PHOTO_MAX_BYTES) return 'Фото больше 5 МБ';
  return null;
}

const rowsOf = (product: Product | null): VariantRow[] =>
  product && product.variants.length > 0
    ? product.variants.map((variant) => ({ id: variant.id, label: variant.label, price: String(variant.price) }))
    : [{ label: '', price: '' }];

const NEW = 'new';

/**
 * «Товары»: what the agent sells, at which prices, with which photos. Separate from the
 * knowledge base because the agent reads the whole active catalog on every reply and may send
 * its photos to the customer. Members see it; only the owner edits — the server enforces the same.
 */
export function ProductsTab({ agentId, owner, currency, timezone }: {
  agentId: string;
  owner: boolean;
  currency: string;
  timezone: string;
}) {
  const query = useApi<Product[]>((signal) => api.listProducts(agentId, signal), [agentId]);
  const [changed, setChanged] = useState<Product[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const items = changed ?? query.data;

  if (items === undefined) {
    return query.error !== undefined
      ? <ErrorState error={query.error} onRetry={query.reload} compact />
      : <Skeleton height={240} />;
  }

  const current = selected === NEW ? null : items.find((product) => product.id === selected) ?? null;
  const editorOpen = selected === NEW || current !== null;

  const saved = (product: Product) => {
    const exists = items.some((item) => item.id === product.id);
    setChanged(exists ? items.map((item) => (item.id === product.id ? product : item)) : [...items, product]);
    setSelected(product.id);
  };

  return (
    <div className="training-products">
      <PromotionsSection agentId={agentId} owner={owner} currency={currency} timezone={timezone} products={items} />

      <div className="training-products__head">
        <p className="training-tab__intro">
          Агент знает цены и описания активных товаров и может отправить клиенту их фото в WhatsApp.
          Если цена здесь расходится с базой знаний, агент называет цену отсюда.
        </p>
        {owner && (
          <button type="button" className="btn-accent" onClick={() => setSelected(NEW)}>Добавить товар</button>
        )}
      </div>

      <div className={`training-products__layout${editorOpen ? ' training-products__layout--open' : ''}`}>
        {items.length === 0 ? (
          <div className="knowledge-inline-state products-empty">
            <p>Товаров пока нет</p>
            <span>{owner ? 'Добавьте товар с ценой и фото — агент начнёт предлагать его клиентам.' : 'Владелец ещё не добавил товары.'}</span>
          </div>
        ) : (
          <ul className="products-list">
            {items.map((product) => (
              <li key={product.id}>
                <ProductCard
                  agentId={agentId}
                  product={product}
                  currency={currency}
                  selected={product.id === selected}
                  onOpen={() => setSelected(product.id)}
                />
              </li>
            ))}
          </ul>
        )}

        {editorOpen && (
          <ProductEditor
            key={selected}
            agentId={agentId}
            product={current}
            owner={owner}
            onSaved={saved}
            onClose={() => setSelected(null)}
            onDeleted={(id) => {
              setChanged(items.filter((item) => item.id !== id));
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

export function ProductCard({ agentId, product, currency, selected, onOpen }: {
  agentId: string;
  product: Product;
  currency: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const cover = product.photos[0];
  return (
    <button type="button" className="products-card" aria-pressed={selected} onClick={onOpen}>
      {cover
        ? <img className="products-card__thumb" src={api.productPhotoUrl(agentId, product.id, cover.id)} alt="" loading="lazy" />
        : <span className="products-card__thumb products-card__thumb--empty" aria-hidden="true">Нет фото</span>}
      <span className="products-card__body">
        <span className="products-card__name">{product.name}</span>
        <span className="products-card__price">{priceRange(product.variants, currency)}</span>
        {!product.active && <span className="products-card__badge">Скрыт от агента</span>}
      </span>
    </button>
  );
}

export function ProductEditor({ agentId, product, owner, onSaved, onClose, onDeleted }: {
  agentId: string;
  product: Product | null;
  owner: boolean;
  onSaved: (product: Product) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [active, setActive] = useState(product?.active ?? true);
  const [rows, setRows] = useState<VariantRow[]>(rowsOf(product));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const readOnly = !owner;

  useEffect(() => setProblem(null), [name, rows]);

  async function save() {
    if (readOnly || busy) return;
    if (name.trim() === '') { setProblem('Укажите название товара'); return; }
    const table = variantsFromRows(rows);
    if (!table.ok) { setProblem(table.message); return; }
    setBusy(true);
    try {
      let next: Product;
      if (product === null) {
        next = await api.createProduct(agentId, { name: name.trim(), description: description.trim(), active, variants: table.variants });
      } else {
        next = await api.updateProduct(agentId, product.id,
          { name: name.trim(), description: description.trim(), active, variants: table.variants });
      }
      onSaved(next);
      setRows(rowsOf(next));
      toast.ok(product === null ? 'Товар добавлен' : 'Товар сохранён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (readOnly || busy || product === null) return;
    if (!window.confirm(`Удалить товар «${product.name}» вместе с фото?`)) return;
    setBusy(true);
    try {
      await api.deleteProduct(agentId, product.id);
      onDeleted(product.id);
      toast.ok('Товар удалён');
    } catch (error) {
      toast.fail(error);
      setBusy(false);
    }
  }

  const setRow = (index: number, patch: Partial<VariantRow>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <section className="products-editor" aria-labelledby="products-editor-title">
      <div className="knowledge-panel-head">
        <div>
          <p className="knowledge-kicker">{product === null ? 'Новый товар' : 'Товар'}</p>
          <h2 id="products-editor-title">{product?.name || 'Без названия'}</h2>
        </div>
        <button type="button" className="btn-link" onClick={onClose}>Закрыть</button>
      </div>

      <form className="products-editor__form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="products-editor__label" htmlFor="product-name">Название</label>
        <input id="product-name" className="knowledge-control" value={name} maxLength={120} disabled={readOnly || busy}
          onChange={(event) => setName(event.target.value)} />

        <label className="products-editor__label" htmlFor="product-description">Описание</label>
        <textarea id="product-description" className="knowledge-control" rows={4} value={description} maxLength={4000}
          disabled={readOnly || busy} onChange={(event) => setDescription(event.target.value)}
          placeholder="Материал, комплектация, особенности — то, что агент расскажет клиенту" />

        <label className="products-editor__check">
          <input type="checkbox" checked={active} disabled={readOnly || busy} onChange={(event) => setActive(event.target.checked)} />
          Агент предлагает этот товар
        </label>

        <fieldset className="products-variants" disabled={readOnly || busy}>
          <legend className="products-editor__label">Размеры и цены</legend>
          <table>
            <thead>
              <tr><th scope="col">Размер или вариант</th><th scope="col">Цена</th>{owner && <th scope="col"><span className="sr-only">Удалить</span></th>}</tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>
                    <input className="knowledge-control" aria-label={`Вариант ${index + 1}`} value={row.label} maxLength={60}
                      placeholder={index === 0 ? 'Например, 40 мм' : ''} onChange={(event) => setRow(index, { label: event.target.value })} />
                  </td>
                  <td>
                    <input className="knowledge-control" aria-label={`Цена варианта ${index + 1}`} value={row.price} inputMode="numeric"
                      placeholder="0" onChange={(event) => setRow(index, { price: event.target.value })} />
                  </td>
                  {owner && (
                    <td>
                      <button type="button" className="btn-sm" aria-label={`Удалить вариант ${index + 1}`}
                        onClick={() => setRows(rows.length === 1 ? [{ label: '', price: '' }] : rows.filter((_, i) => i !== index))}>✕</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {owner && rows.length < VARIANTS_PER_PRODUCT && (
            <button type="button" className="btn-link" onClick={() => setRows([...rows, { label: '', price: '' }])}>+ Добавить вариант</button>
          )}
          <p className="products-editor__note">Одна цена без размеров — оставьте название варианта пустым.</p>
        </fieldset>

        {problem && <p className="products-editor__problem" role="alert">{problem}</p>}
        {owner && (
          <div className="products-editor__actions">
            <button type="submit" className="btn-accent" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            {product !== null && <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>Удалить товар</button>}
          </div>
        )}
      </form>

      {product === null
        ? owner && <p className="products-editor__note">Фото можно добавить после сохранения товара.</p>
        : <ProductPhotos agentId={agentId} product={product} owner={owner} onChanged={onSaved} />}
    </section>
  );
}

export function ProductPhotos({ agentId, product, owner, onChanged }: {
  agentId: string;
  product: Product;
  owner: boolean;
  onChanged: (product: Product) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function run(action: () => Promise<Product>) {
    setBusy(true);
    try {
      onChanged(await action());
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: FileList | File[]) {
    if (!owner || busy) return;
    let latest = product;
    setBusy(true);
    try {
      // One at a time, so a refused file does not hide the ones that did go up.
      for (const file of Array.from(files)) {
        const wrong = photoProblem(file, latest.photos.length);
        if (wrong) { toast.fail(null, `${file.name}: ${wrong}`); continue; }
        latest = await api.uploadProductPhoto(agentId, product.id, file);
        onChanged(latest);
      }
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  const move = (index: number, by: -1 | 1) => {
    const ids = product.photos.map((photo) => photo.id);
    const [taken] = ids.splice(index, 1);
    ids.splice(index + by, 0, taken!);
    void run(() => api.reorderProductPhotos(agentId, product.id, ids));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files);
  };

  return (
    <div className="products-photos">
      <p className="products-editor__label">Фото · {product.photos.length} из {PHOTOS_PER_PRODUCT}</p>
      {product.photos.length === 0 && !owner && <p className="products-editor__note">Фото нет.</p>}
      <ul className="products-photos__grid">
        {product.photos.map((photo, index) => (
          <li key={photo.id} className="products-photos__item">
            <img src={api.productPhotoUrl(agentId, product.id, photo.id)} alt={photo.caption ?? `Фото ${index + 1}`} loading="lazy" />
            {photo.caption && <span className="products-photos__caption">{photo.caption}</span>}
            {owner && (
              <span className="products-photos__tools">
                <button type="button" className="btn-sm" aria-label="Левее" disabled={busy || index === 0} onClick={() => move(index, -1)}>←</button>
                <button type="button" className="btn-sm" aria-label="Правее" disabled={busy || index === product.photos.length - 1}
                  onClick={() => move(index, 1)}>→</button>
                <button type="button" className="btn-sm" aria-label="Подпись" disabled={busy} onClick={() => {
                  const caption = window.prompt('Подпись для агента (клиент её не увидит)', photo.caption ?? '');
                  if (caption !== null) void run(() => api.updateProductPhoto(agentId, product.id, photo.id, caption));
                }}>Aa</button>
                <button type="button" className="btn-sm" aria-label="Удалить фото" disabled={busy} onClick={() => {
                  if (window.confirm('Удалить фото?')) void run(() => api.deleteProductPhoto(agentId, product.id, photo.id));
                }}>✕</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {owner && product.photos.length < PHOTOS_PER_PRODUCT && (
        <div
          className={`products-photos__drop${dragging ? ' products-photos__drop--active' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span>{busy ? 'Загружаем…' : 'Перетащите фото сюда или'}</span>
          <label className="btn-sm products-photos__pick">
            выберите файлы
            <input type="file" accept={PHOTO_TYPES.join(',')} multiple hidden disabled={busy}
              onChange={(event) => { if (event.target.files) void upload(event.target.files); event.target.value = ''; }} />
          </label>
          <span className="products-editor__note">JPEG, PNG или WebP, до 5 МБ. Агент отправит фото, когда клиент попросит показать товар.</span>
        </div>
      )}
    </div>
  );
}
