import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import type { KbImport, KbItemKind } from '@/types';

/**
 * The two ways to fill the base without typing: a paste and a page.
 *
 * Both are owner-only on the server, so the screen renders this panel for an owner only —
 * a member shown these buttons would be pressing something that answers 403.
 */

const control: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};

const label: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 5 };

const hint: CSSProperties = { fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 };

/** One name per kind, used by this panel and by the list. */
export const KIND_LABELS: { id: KbItemKind; label: string }[] = [
  { id: 'product', label: 'Товар' },
  { id: 'qa', label: 'Вопрос-ответ' },
  { id: 'procedure', label: 'Процедура' },
  { id: 'contact', label: 'Контакт' },
  { id: 'other', label: 'Другое' },
];

export const kindLabel = (kind: KbItemKind): string =>
  KIND_LABELS.find((entry) => entry.id === kind)?.label ?? kind;

export function ImportPanel({
  agentId,
  onImported,
}: {
  agentId: string;
  /** The screen says what was made and rereads its lists — the panel does neither. */
  onImported: (result: KbImport) => void;
}) {
  return (
    <Card>
      <CardHead title="Загрузить" gap={12} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <PasteForm agentId={agentId} onImported={onImported} />
        <PageForm agentId={agentId} onImported={onImported} />
      </div>
    </Card>
  );
}

function PasteForm({
  agentId,
  onImported,
}: {
  agentId: string;
  onImported: (result: KbImport) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<KbItemKind>('other');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !title.trim() || !text.trim()) return;

    setBusy(true);
    try {
      const result = await api.importKbText(agentId, { title, kind, text });
      // Cleared only once the server has it. A paste is minutes of someone's work, and a
      // box emptied before the answer arrives loses it to a dropped connection.
      setTitle('');
      setText('');
      onImported(result);
    } catch (error) {
      // The server's message names the actual reason — an empty paste, a title too long —
      // and it is written in this person's language, so it is shown as it came.
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ flex: '1 1 320px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ fontSize: 12, fontWeight: 650 }}>Вставить текст</div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={label}>Название</div>
          <input
            style={control}
            value={title}
            placeholder="Прайс на сентябрь"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <div style={label}>Тип записей</div>
          <select
            style={control}
            value={kind}
            aria-label="Тип записей"
            onChange={(e) => setKind(e.target.value as KbItemKind)}
          >
            {KIND_LABELS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div style={label}>Текст</div>
        <textarea
          style={{ ...control, minHeight: 120, resize: 'vertical', lineHeight: 1.45 }}
          value={text}
          placeholder="Доставка&#10;По городу 1500 ₸, бесплатно от 20 000 ₸.&#10;&#10;Возврат&#10;14 дней, чек не нужен."
          onChange={(e) => setText(e.target.value)}
        />
        <div style={{ ...hint, marginTop: 5 }}>
          Пустая строка разделяет записи, первая строка каждой — заголовок.
        </div>
      </div>

      <div>
        <button type="submit" className="btn-sm" disabled={busy || !title.trim() || !text.trim()}>
          {busy ? 'Загружаем…' : 'Загрузить текст'}
        </button>
      </div>
    </form>
  );
}

function PageForm({
  agentId,
  onImported,
}: {
  agentId: string;
  onImported: (result: KbImport) => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !url.trim()) return;

    setBusy(true);
    try {
      const result = await api.importKbPage(agentId, url);
      setUrl('');
      onImported(result);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ flex: '1 1 260px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ fontSize: 12, fontWeight: 650 }}>Загрузить страницу</div>

      <div>
        <div style={label}>Адрес</div>
        <input
          style={control}
          value={url}
          placeholder="https://example.kz/dostavka"
          onChange={(e) => setUrl(e.target.value)}
        />
        <div style={{ ...hint, marginTop: 5 }}>
          Заголовки страницы становятся заголовками записей. Страницу можно обновить позже —
          то, что вы поправите руками, при обновлении сохранится. Уже загруженный адрес не
          продублируется: страница просто прочитается заново.
        </div>
      </div>

      <div>
        {/* The fetch happens inside the request and takes seconds. A button that looks
            idle for five seconds gets pressed a second time, so it says what it is doing
            and refuses the second press. */}
        <button type="submit" className="btn-sm" disabled={busy || !url.trim()}>
          {busy ? 'Загружаем страницу…' : 'Загрузить страницу'}
        </button>
      </div>
    </form>
  );
}
