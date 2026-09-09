import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { ApiError } from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import type { KbImport, KbNote, KbNoteKind, KbSource } from '@/types';

/**
 * The two ways to fill the vault without typing, and what happened to what got filled.
 *
 * Both are owner-only on the server, so the screen renders this panel for an owner only —
 * a member shown these buttons would be pressing something that answers 403. It also owns
 * the sources list: reimporting or deleting a source is the same owner-only decision as
 * making one, and keeping the three together means the tree pane does not have to know
 * sources exist at all — it only ever needs to be told notes changed.
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

/** One name per kind, used by this panel's paste form. */
export const KIND_LABELS: { id: KbNoteKind; label: string }[] = [
  { id: 'product', label: 'Товар' },
  { id: 'qa', label: 'Вопрос-ответ' },
  { id: 'procedure', label: 'Процедура' },
  { id: 'contact', label: 'Контакт' },
  { id: 'other', label: 'Другое' },
];

export const kindLabel = (kind: KbNoteKind): string =>
  KIND_LABELS.find((entry) => entry.id === kind)?.label ?? kind;

/** «заметка» / «заметки» / «заметок». Russian counts three ways and this panel shows numbers. */
function notesWord(count: number): string {
  const hundreds = count % 100;
  const tens = count % 10;
  if (tens === 1 && hundreds !== 11) return 'заметка';
  if (tens >= 2 && tens <= 4 && (hundreds < 12 || hundreds > 14)) return 'заметки';
  return 'заметок';
}

/** «Создана 1 заметка» · «Создано 3 заметки» · «Создано 12 заметок». */
const createdLine = (count: number) =>
  `${count % 10 === 1 && count % 100 !== 11 ? 'Создана' : 'Создано'} ${count} ${notesWord(count)}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * The `KbImport` a failed reimport answers with.
 *
 * `humanError` only knows the plain `{message}` shape every other failure carries — this one
 * carries the source, now marked failed, and its own Russian reason, because the server has
 * something concrete to show a *refresh* that a first import never has. Read directly rather
 * than through `humanError`, or the panel would show the generic «Ошибка на сервере» over a
 * reason the server already spelled out.
 */
function reimportFailure(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || typeof error.body !== 'object' || error.body === null) {
    return undefined;
  }
  const body = error.body as { source?: { error?: unknown } };
  return typeof body.source?.error === 'string' ? body.source.error : undefined;
}

export function ImportPanel({
  agentId,
  onChanged,
}: {
  agentId: string;
  /** A note was created, replaced or renamed — the tree pane must reread its list. */
  onChanged: () => void;
}) {
  const [imported, setImported] = useState<KbImport | null>(null);
  const sources = useApi<KbSource[]>((signal) => api.listKbSources(agentId, signal), [agentId]);

  function handleImported(result: KbImport) {
    setImported(result);
    onChanged();
    sources.reload();
  }

  return (
    <Card>
      <CardHead title="Загрузить" gap={12} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <PasteForm agentId={agentId} onImported={handleImported} />
        <PageForm agentId={agentId} onImported={handleImported} />
      </div>

      {imported && <ImportResult result={imported} onHide={() => setImported(null)} />}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 8 }}>Источники</div>
        <Async state={sources} skeleton={<Skeleton height={70} />} compactError>
          {(loaded) =>
            loaded.length === 0 ? (
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                Пока ничего не загружали. Заметки, добавленные руками, источника не имеют.
              </div>
            ) : (
              <SourceList
                agentId={agentId}
                sources={loaded}
                onChanged={() => {
                  sources.reload();
                  onChanged();
                }}
                onReimported={handleImported}
              />
            )
          }
        </Async>
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
  const [kind, setKind] = useState<KbNoteKind>('other');
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
          <div style={label}>Тип заметок</div>
          <select
            style={control}
            value={kind}
            aria-label="Тип заметок"
            onChange={(e) => setKind(e.target.value as KbNoteKind)}
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
          Пустая строка начинает новую заметку, первая строка каждой — её название.
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
          Страница станет одной заметкой, а её заголовки — разделами внутри неё. Страницу
          можно обновить позже — то, что вы поправите руками, при обновлении сохранится. Уже
          загруженный адрес не продублируется: страница просто прочитается заново.
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

/**
 * What the last import produced, named, before the owner walks away from the panel.
 *
 * The two cases are worded apart. A first import answers with the notes it created, so it
 * says how many were created. An update answers with everything the source holds
 * afterwards — the fresh notes plus the ones a person had edited, which it kept and did not
 * make — so «Создано N заметок» would be a false count of a true list.
 */
function ImportResult({ result, onHide }: { result: KbImport; onHide: () => void }) {
  const { reimported, keptEdited } = result;
  const box = useRef<HTMLDivElement>(null);

  // The sources list sits at the bottom of this panel, below the two forms, and a reimport
  // is pressed from a row down there: without the scroll the answer would land above where
  // the owner is looking.
  useEffect(() => {
    if (reimported) box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [reimported, result]);

  return (
    <div ref={box} className="sunken-box" style={{ padding: '12px 14px', marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 650 }}>
          {reimported
            ? `В источнике «${result.source.title}» теперь ${result.notes.length} ${notesWord(result.notes.length)}`
            : `${createdLine(result.notes.length)} из «${result.source.title}»`}
        </span>
        <button
          type="button"
          className="btn-link"
          style={{ marginLeft: 'auto', fontSize: 11.5 }}
          onClick={onHide}
        >
          Скрыть
        </button>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.45 }}>
        {!reimported
          ? 'Проверьте, что текст разбился так, как вы ожидали.'
          : keptEdited === 0
            ? 'Все заметки источника заменены свежими со страницы.'
            : `Заметки со страницы загружены заново. Исправленных вручную: ${keptEdited} — их не ` +
              'трогали, они остались как были. Страница могла с тех пор измениться: проверьте их в дереве слева.'}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {result.notes.map((created: KbNote) => (
          <span
            key={created.id}
            className="ellipsis"
            style={{
              maxWidth: 260,
              fontSize: 11.5,
              padding: '4px 9px',
              borderRadius: 7,
              background: 'var(--sunken-2)',
              border: '1px solid var(--line)',
              color: 'var(--text-3)',
            }}
          >
            {created.title}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Where the imported notes came from. Owner-only, because every button here is. */
function SourceList({
  agentId,
  sources,
  onChanged,
  onReimported,
}: {
  agentId: string;
  sources: KbSource[];
  onChanged: () => void;
  /** Answered with everything the source holds now, not with what was just created. */
  onReimported: (result: KbImport) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function reimport(source: KbSource) {
    if (busy) return;
    setBusy(source.id);
    try {
      const result = await api.reimportKbSource(agentId, source.id);
      toast.ok('Страница обновлена');
      onReimported(result);
    } catch (error) {
      // A refresh whose fetch failed answers 502 with a `KbImport`-shaped body, not a
      // `{message}` one — read above by `reimportFailure`. Whatever the shape, the answer
      // did not succeed: `onReimported` is not called, and the row is reread so its now-failed
      // status and error text (already written server-side) replace the stale ones on screen.
      toast.fail(error, reimportFailure(error));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function remove(source: KbSource) {
    if (busy) return;
    if (
      !window.confirm(
        `Удалить источник «${source.title}»? Заметки останутся в базе — исчезнет только ` +
          'отметка о том, откуда они взялись, и обновить страницу будет уже нельзя.',
      )
    ) {
      return;
    }

    setBusy(source.id);
    try {
      await api.deleteKbSource(agentId, source.id);
      toast.ok('Источник удалён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {sources.map((source) => (
        <div key={source.id} className="sunken-box" style={{ padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {source.title}
              </div>
              {source.url && (
                <div
                  className="ellipsis mono"
                  style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}
                >
                  {source.url}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                {source.kind === 'page' ? 'Страница' : 'Текст'} · {when(source.createdAt)} ·{' '}
                {source.itemCount} {notesWord(source.itemCount)}
              </div>
              {source.error && (
                <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>
                  {source.error}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
              {source.kind === 'page' && (
                <button
                  type="button"
                  className="btn-sm"
                  disabled={busy === source.id}
                  onClick={() => reimport(source)}
                >
                  {busy === source.id ? 'Обновляем…' : 'Обновить'}
                </button>
              )}
              <button
                type="button"
                className="btn-link"
                style={{ fontSize: 11.5, color: 'var(--danger)' }}
                disabled={busy === source.id}
                onClick={() => remove(source)}
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
