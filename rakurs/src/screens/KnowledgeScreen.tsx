import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { ImportPanel, KIND_LABELS, kindLabel } from '@/components/knowledge/ImportPanel';
import { Card, CardHead, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, RowsSkeleton, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi, useDebounced } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { KbImport, KbItem, KbItemKind, KbSource } from '@/types';

/**
 * What the agent will answer from, and the box for asking it what it knows.
 *
 * The search field calls the very route stage 5's agent calls, so typing a customer's
 * question here answers «would it find this?» — the only question worth asking of a
 * knowledge base. Nothing is filtered in the browser for that reason.
 */

/** Mirrors `LIST_LIMIT` in `server/src/api/knowledge.ts`. Browsing is capped, not paged. */
const LIST_LIMIT = 100;
/** Mirrors `SEARCH_LIMIT` there: a search answers with the best twenty and stops. */
const SEARCH_LIMIT = 20;

/** How many titles an import result names before it starts counting. */
const TITLES_SHOWN = 12;

type Filter = 'all' | KbItemKind;

const FILTERS: SegmentItem<Filter>[] = [
  { id: 'all', label: 'Все' },
  { id: 'product', label: 'Товары' },
  { id: 'qa', label: 'Вопросы' },
  { id: 'procedure', label: 'Процедуры' },
  { id: 'contact', label: 'Контакты' },
  { id: 'other', label: 'Другое' },
];

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

const note: CSSProperties = {
  padding: '10px 18px 14px',
  fontSize: 11.5,
  color: 'var(--text-dim)',
  lineHeight: 1.45,
};

/** «запись» / «записи» / «записей». Russian counts three ways and this screen shows numbers. */
function records(count: number): string {
  const hundreds = count % 100;
  const tens = count % 10;
  if (tens === 1 && hundreds !== 11) return 'запись';
  if (tens >= 2 && tens <= 4 && (hundreds < 12 || hundreds > 14)) return 'записи';
  return 'записей';
}

/** «Создана 1 запись» · «Создано 3 записи» · «Создано 12 записей». */
const createdLine = (count: number) =>
  `${count % 10 === 1 && count % 100 !== 11 ? 'Создана' : 'Создано'} ${count} ${records(count)}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** The opening of an item on one line, so a row is a row and not a paragraph. */
function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 170 ? `${flat.slice(0, 170)}…` : flat;
}

export function KnowledgeScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const [kind, setKind] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Debounced so a word typed into the box is one search, not six.
  const search = useDebounced(query).trim();

  const [items, setItems] = useState<KbItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The outcome of the last import. Whether it created a source or updated one the agent
  // already had is the server's to say — pasting an address twice is an update too, and the
  // screen cannot tell that from which button was pressed.
  const [imported, setImported] = useState<KbImport | null>(null);

  const list = useApi<KbItem[]>(
    (signal) =>
      api.listKbItems(agent.id, { kind: kind === 'all' ? undefined : kind, q: search }, signal),
    [agent.id, kind, search],
  );

  const sources = useApi<KbSource[]>(
    // Only an owner may reimport or delete a source, and only an owner is shown the list,
    // so for anybody else this is a request per screen open that nothing reads.
    (signal) => (owner ? api.listKbSources(agent.id, signal) : Promise.resolve([])),
    [agent.id, owner],
  );

  // The previous answer belongs to a different question and must not sit under a new one
  // for even a frame. Declared before the effect below so the two run in that order.
  useEffect(() => {
    setItems(null);
    setOpen(null);
  }, [agent.id, kind, search]);

  // The list is held locally so a save can put the row the server answered with back in
  // place. `useApi` owns the loading and the errors; this owns what is on screen.
  useEffect(() => {
    if (list.data) setItems(list.data);
  }, [list.data]);

  const replaceItem = (saved: KbItem) =>
    setItems((prev) => (prev ?? []).map((item) => (item.id === saved.id ? saved : item)));

  /** A new item may not belong under the current filter, so the server is asked again. */
  function reloadItems() {
    list.reload();
  }

  function handleImported(result: KbImport) {
    setImported(result);
    setOpen(null);
    reloadItems();
    sources.reload();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {owner && <ImportPanel agentId={agent.id} onImported={handleImported} />}

      {imported && <ImportResult result={imported} onHide={() => setImported(null)} />}

      <Card pad={false}>
        <div style={{ padding: '16px 18px 12px' }}>
          <CardHead
            title="База знаний"
            gap={12}
            right={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  value={query}
                  type="search"
                  aria-label="Поиск по базе знаний"
                  placeholder="Вопрос клиента"
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ ...control, width: 220 }}
                />
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => {
                    setAdding((was) => !was);
                    setOpen(null);
                  }}
                >
                  {adding ? 'Отмена' : 'Добавить запись'}
                </button>
              </div>
            }
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Segmented items={FILTERS} value={kind} onChange={setKind} size="sm" />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Поиск здесь — тот же, которым пользуется ИИ.
            </span>
          </div>
        </div>

        {adding && (
          <div style={{ padding: '0 18px 16px' }}>
            <ItemForm
              agentId={agent.id}
              item={null}
              onSaved={() => {
                setAdding(false);
                reloadItems();
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}

        <Async state={list} skeleton={<RowsSkeleton rows={6} />}>
          {() =>
            items === null ? (
              <RowsSkeleton rows={6} />
            ) : (
              <>
                {/* There are rows on screen and the last attempt to refresh them failed —
                    `Async` keeps the previous answer in that case. Said out loud, because a
                    row deleted a moment ago would otherwise go on sitting here as though it
                    still existed, and a record just created would be nowhere to be seen. */}
                {list.error !== undefined && (
                  <div
                    style={{
                      ...note,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 18px',
                      color: 'var(--danger)',
                    }}
                  >
                    <span>Список мог устареть: обновить его не удалось.</span>
                    <button type="button" className="btn-sm" onClick={list.reload}>
                      Обновить
                    </button>
                  </div>
                )}

                {items.length === 0 ? (
                  <EmptyState>
                    {search !== '' ? (
                      <>
                        По запросу «{search}» ничего не нашлось. ИИ ответил бы так же —
                        значит, этого в базе нет.
                      </>
                    ) : kind !== 'all' ? (
                      'Записей этого типа пока нет. Тип можно поменять у любой записи.'
                    ) : owner ? (
                      'База знаний пуста. Вставьте текст или загрузите страницу выше — или добавьте первую запись руками.'
                    ) : (
                      'База знаний пуста. Добавьте первую запись — отвечать агенту пока нечем.'
                    )}
                  </EmptyState>
                ) : (
                  <>
                    {items.map((item) => (
                      <ItemRow
                        key={item.id}
                        agentId={agent.id}
                        item={item}
                        open={open === item.id}
                        onToggle={() => {
                          setOpen(open === item.id ? null : item.id);
                          setAdding(false);
                        }}
                        onSaved={(saved) => {
                          replaceItem(saved);
                          setOpen(null);
                          // An edit can move a row out of the list it is sitting in: a new
                          // kind may not match the filter, and reworded text may no longer
                          // match the query. Which of those is true is the ranker's to say,
                          // so the server is asked again rather than guessed at here.
                          if ((kind !== 'all' && saved.kind !== kind) || search !== '') {
                            reloadItems();
                          }
                        }}
                        onDeleted={() => {
                          setOpen(null);
                          reloadItems();
                        }}
                      />
                    ))}

                    {/* Said out loud, because an owner who sees exactly a hundred rows and
                        no pager concludes their store ends there and starts deleting. */}
                    {search === '' && items.length >= LIST_LIMIT && (
                      <div style={note}>
                        Показаны {LIST_LIMIT} последних записей — в базе их может быть
                        больше. Остальные находятся поиском.
                      </div>
                    )}
                    {search !== '' && items.length >= SEARCH_LIMIT && (
                      <div style={note}>
                        Показаны {SEARCH_LIMIT} самых подходящих записей. Уточните запрос,
                        если нужной среди них нет.
                      </div>
                    )}
                  </>
                )}
              </>
            )
          }
        </Async>
      </Card>

      {owner && (
        <Card>
          <CardHead title="Источники" gap={12} />
          <Async state={sources} skeleton={<Skeleton height={90} />} compactError>
            {(loaded) =>
              loaded.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                  Пока ничего не загружали. Записи, добавленные руками, источника не имеют.
                </div>
              ) : (
                <SourceList
                  agentId={agent.id}
                  sources={loaded}
                  onChanged={sources.reload}
                  onReimported={handleImported}
                />
              )
            }
          </Async>
        </Card>
      )}
    </div>
  );
}

/**
 * What the last import produced, named, before the owner walks away from the screen.
 *
 * The two cases are worded apart. A first import answers with the items it created, so it
 * says how many were created. An update answers with everything the source holds
 * afterwards — the fresh items plus the ones a person had edited, which it kept and did not
 * make — so «Создано N записей» would be a false count of a true list.
 */
function ImportResult({ result, onHide }: { result: KbImport; onHide: () => void }) {
  const { reimported, keptEdited } = result;
  const shown = result.items.slice(0, TITLES_SHOWN);
  const rest = result.items.length - shown.length;
  const box = useRef<HTMLDivElement>(null);

  // «Обновить» sits at the bottom of the screen, in the sources card, and this card is at
  // the top: without the scroll the answer to a reimport appears where nobody is looking.
  useEffect(() => {
    if (reimported) box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [reimported, result]);

  return (
    <div ref={box}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 650 }}>
            {reimported
              ? `В источнике «${result.source.title}» теперь ${result.items.length} ${records(result.items.length)}`
              : `${createdLine(result.items.length)} из «${result.source.title}»`}
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

        {/* The count and the titles, at once. A price list pasted without blank lines
            becomes ONE record by design, and «Создана 1 запись» read straight away is the
            only thing that saves the owner from finding that out a week later.

            An update says the same kind of thing about the records it kept. Everything the
            page yields is written, and a hand-corrected record is never one of the things
            replaced — so the two can now sit side by side saying different things about the
            same subject. That is a question about the world, not about the data: has the
            page moved on, or was the correction right? Nobody here can answer it, so the
            owner is told how many records to go and look at. */}
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.45 }}>
          {!reimported
            ? 'Проверьте, что текст разбился так, как вы ожидали.'
            : keptEdited === 0
              ? 'Все записи источника заменены свежими со страницы.'
              : `Записи со страницы загружены заново. Исправленных вручную записей: ` +
                `${keptEdited} — их не трогали, они остались как были. Страница могла с тех ` +
                'пор измениться: проверьте их и удалите то, что устарело.'}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {shown.map((item) => (
            <span
              key={item.id}
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
              {item.title}
            </span>
          ))}
          {rest > 0 && (
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)', alignSelf: 'center' }}>
              и ещё {rest} {records(rest)}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

function ItemRow({
  agentId,
  item,
  open,
  onToggle,
  onSaved,
  onDeleted,
}: {
  agentId: string;
  item: KbItem;
  open: boolean;
  onToggle: () => void;
  onSaved: (saved: KbItem) => void;
  onDeleted: () => void;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--line-soft)', padding: '11px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{item.title}</div>
          <div
            className="ellipsis"
            style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}
          >
            {preview(item.content)}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 7,
              flexWrap: 'wrap',
              fontSize: 11,
              color: 'var(--text-dim)',
              marginTop: 4,
            }}
          >
            <span>{kindLabel(item.kind)}</span>
            <span>·</span>
            <span>{item.sourceTitle ?? 'Добавлено вручную'}</span>
            {item.edited && (
              <>
                <span>·</span>
                {/* Worth saying: this is the text a reimport of the page will not touch. */}
                <span>изменено вручную</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          className="btn-link"
          style={{ fontSize: 11.5, flex: '0 0 auto' }}
          onClick={onToggle}
        >
          {open ? 'Свернуть' : 'Изменить'}
        </button>
      </div>

      {open && (
        <ItemForm
          agentId={agentId}
          item={item}
          onSaved={onSaved}
          onCancel={onToggle}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

/**
 * The one editor, used empty for a new record and filled for an existing one.
 *
 * Nothing is cleared or collapsed until the server has answered: a refusal leaves what the
 * person typed exactly where they typed it, with the reason in the toast.
 */
function ItemForm({
  agentId,
  item,
  onSaved,
  onCancel,
  onDeleted,
}: {
  agentId: string;
  /** Null for a new record. */
  item: KbItem | null;
  onSaved: (saved: KbItem) => void;
  onCancel: () => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(item?.title ?? '');
  const [kind, setKind] = useState<KbItemKind>(item?.kind ?? 'other');
  const [content, setContent] = useState(item?.content ?? '');
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !title.trim() || !content.trim()) return;

    setSaving(true);
    try {
      const saved = item
        ? await api.updateKbItem(agentId, item.id, { kind, title, content })
        : await api.createKbItem(agentId, { kind, title, content });
      toast.ok('Сохранено');
      // Handed up whole. The row on screen is replaced by what the server stored, never by
      // what this form thinks it sent: a PATCH also flips `edited`, and a locally patched
      // row would go on claiming the page import still owns the text.
      onSaved(saved);
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!item || saving) return;
    if (!window.confirm(`Удалить запись «${item.title}»? Это нельзя отменить.`)) return;

    setSaving(true);
    try {
      await api.deleteKbItem(agentId, item.id);
      toast.ok('Запись удалена');
      onDeleted?.();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={save}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={label}>Заголовок</div>
          <input
            style={control}
            value={title}
            placeholder="Условия доставки"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <div style={label}>Тип</div>
          <select
            style={control}
            value={kind}
            aria-label="Тип записи"
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
          style={{ ...control, minHeight: 96, resize: 'vertical', lineHeight: 1.45 }}
          value={content}
          placeholder="Короткий ответ, который агент сможет процитировать"
          onChange={(e) => setContent(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="submit"
          className="btn-sm"
          disabled={saving || !title.trim() || !content.trim()}
        >
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={onCancel}>
          Отмена
        </button>
        {item && (
          <button
            type="button"
            className="btn-link"
            style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--danger)' }}
            disabled={saving}
            onClick={remove}
          >
            Удалить
          </button>
        )}
      </div>
    </form>
  );
}

/** Where the imported records came from. Owner-only, because every button here is. */
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
      toast.fail(error);
      // A failed reimport writes the reason onto the source row, and that reason is what
      // this list is for — so it is reread even though nothing was imported.
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function remove(source: KbSource) {
    if (busy) return;
    if (
      !window.confirm(
        `Удалить источник «${source.title}»? Записи останутся в базе — исчезнет только ` +
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
                {source.itemCount} {records(source.itemCount)}
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
                  className="btn-link"
                  style={{ fontSize: 11.5 }}
                  disabled={busy !== null}
                  onClick={() => reimport(source)}
                >
                  {busy === source.id ? 'Обновляем…' : 'Обновить'}
                </button>
              )}
              <button
                type="button"
                className="btn-link"
                style={{ fontSize: 11.5, color: 'var(--danger)' }}
                disabled={busy !== null}
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
