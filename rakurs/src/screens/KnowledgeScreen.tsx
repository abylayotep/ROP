import { useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { ImportPanel } from '@/components/knowledge/ImportPanel';
import { NoteEditor } from '@/components/knowledge/NoteEditor';
import { buildTree, NoteTree } from '@/components/knowledge/NoteTree';
import { NotePanel } from '@/components/knowledge/NotePanel';
import { Card, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { KbNote, KbNoteDetail, KbNoteKind } from '@/types';

/**
 * The vault: a folder tree, a markdown editor, and a panel of what points where.
 *
 * Three panes, three concerns. The tree (left) only ever has to answer «which notes, and
 * where» — search and the kind filter both narrow it, but neither one owns a note's text.
 * The editor (centre) only ever shows or edits one note's body. The panel (right) only ever
 * answers questions *about* the open note: what links here, what it links to, what the
 * agent would retrieve for it. Nothing here filters what the agent sees — that already
 * happened server-side, in what got imported and what got written; this screen reads and
 * edits the same store, honestly.
 */

/** Not a real note id — every note id is a uuid the server minted, and this string never
 * collides with one. Marks the centre pane as "a blank note, not yet saved". */
const NEW = 'new';

/** Mirrors `LIST_LIMIT` in `server/src/api/knowledge.ts`. Browsing is capped, not paged. */
const LIST_LIMIT = 100;
/** Mirrors `SEARCH_LIMIT` there: a search answers with the best twenty and stops. */
const SEARCH_LIMIT = 20;

type Filter = 'all' | KbNoteKind;

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

export function KnowledgeScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const [kind, setKind] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Debounced so a word typed into the box is one search, not six.
  const search = useDebounced(query).trim();

  const [params, setParams] = useSearchParams();
  const selected = params.get('note');
  const select = (noteId: string | null) =>
    noteId === null ? setParams({}, { replace: true }) : setParams({ note: noteId }, { replace: true });

  /**
   * The tree's own source: the same ranker the agent uses when `search` is not empty, the
   * plain recent list otherwise. `GET /notes?q=` is what stage 5's agent calls, so this is
   * the owner's honest test of «would the agent find this note at all» — the same reason
   * the right pane's own search box exists.
   */
  const list = useApi<KbNote[]>(
    (signal) => api.listKbNotes(agent.id, { q: search || undefined }, signal),
    [agent.id, search],
  );

  /**
   * A second, always-unfiltered fetch, purely for titles.
   *
   * `[[` autocomplete and a wiki link's «is this broken» both need every title in the
   * vault, not the ones the current search happened to match — a note open in the centre
   * pane must not have its own real link called broken just because the left pane's search
   * box narrowed the tree to something else.
   *
   * Still capped at `LIST_LIMIT`, same as the plain list: a vault past a hundred notes can
   * call a link to its own hundred-and-first note broken, or leave it out of `[[`'s
   * suggestions. Rare enough, and self-correcting enough once the target is opened once by
   * search, not to justify a paged fetch just for a title list.
   */
  const vault = useApi<KbNote[]>((signal) => api.listKbNotes(agent.id, {}, signal), [agent.id]);
  const titles = useMemo(() => new Set(vault.data?.map((n) => n.title) ?? []), [vault.data]);

  const detail = useApi<KbNoteDetail | null>(
    (signal) =>
      selected && selected !== NEW ? api.getKbNote(agent.id, selected, signal) : Promise.resolve(null),
    [agent.id, selected],
  );

  /** A note was created, saved under a new path, or deleted — both lists may have moved. */
  function refreshLists() {
    list.reload();
    vault.reload();
  }

  // The kind filter is not sent to the server — `GET /notes` does not narrow by kind, only
  // by `q` — so it is applied here, over whichever list `search` produced.
  const filtered = useMemo(
    () => (list.data ?? []).filter((item) => kind === 'all' || item.kind === kind),
    [list.data, kind],
  );
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ width: 300, flex: '0 0 300px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card pad={false}>
          <div style={{ padding: '14px 14px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              value={query}
              type="search"
              aria-label="Поиск по базе знаний"
              placeholder="Вопрос клиента"
              onChange={(e) => setQuery(e.target.value)}
              style={control}
            />
            <Segmented items={FILTERS} value={kind} onChange={setKind} size="sm" />
            <button type="button" className="btn-sm" onClick={() => select(NEW)}>
              + Новая заметка
            </button>
          </div>

          <div
            style={{
              borderTop: '1px solid var(--line-soft)',
              padding: '8px',
              maxHeight: 520,
              overflowY: 'auto',
            }}
          >
            <Async state={list} skeleton={<Skeleton height={220} />} compactError>
              {() =>
                tree.length === 0 ? (
                  <EmptyState>
                    {search !== ''
                      ? `По запросу «${search}» ничего не нашлось. ИИ ответил бы так же.`
                      : kind !== 'all'
                        ? 'Заметок этого типа пока нет.'
                        : owner
                          ? 'База знаний пуста. Загрузите текст или страницу ниже — или создайте первую заметку.'
                          : 'База знаний пуста. Создайте первую заметку — отвечать агенту пока нечем.'}
                  </EmptyState>
                ) : (
                  <>
                    <NoteTree nodes={tree} selectedId={selected} onSelect={select} />
                    {/* Said out loud, because a hundred rows and no pager reads as «the vault
                        ends here» rather than «browsing stops here, search does not». */}
                    {search === '' && (list.data?.length ?? 0) >= LIST_LIMIT && (
                      <div style={{ padding: '8px 6px 2px', fontSize: 11, color: 'var(--text-dim)' }}>
                        Показаны {LIST_LIMIT} последних заметок — в базе их может быть больше.
                        Остальные находятся поиском.
                      </div>
                    )}
                    {search !== '' && (list.data?.length ?? 0) >= SEARCH_LIMIT && (
                      <div style={{ padding: '8px 6px 2px', fontSize: 11, color: 'var(--text-dim)' }}>
                        Показаны {SEARCH_LIMIT} самых подходящих заметок. Уточните запрос, если
                        нужной среди них нет.
                      </div>
                    )}
                  </>
                )
              }
            </Async>
          </div>
        </Card>

        {owner && <ImportPanel agentId={agent.id} onChanged={refreshLists} />}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {selected === null && (
          <Card>
            <EmptyState>Выберите заметку слева или создайте новую.</EmptyState>
          </Card>
        )}

        {selected === NEW && (
          <NoteEditor
            key={NEW}
            agentId={agent.id}
            detail={null}
            titles={titles}
            onCancel={() => select(null)}
            onSaved={(saved) => {
              refreshLists();
              select(saved.id);
            }}
            onDeleted={() => select(null)}
            onOpenNote={select}
          />
        )}

        {selected !== null && selected !== NEW && (
          <Async state={detail} skeleton={<Skeleton height={420} />}>
            {(loaded) =>
              loaded && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <NoteEditor
                      key={selected}
                      agentId={agent.id}
                      detail={loaded}
                      titles={titles}
                      onSaved={() => {
                        refreshLists();
                        detail.reload();
                      }}
                      onDeleted={() => {
                        refreshLists();
                        select(null);
                      }}
                      onOpenNote={select}
                    />
                  </div>
                  <div style={{ width: 300, flex: '0 0 300px' }}>
                    <NotePanel key={selected} agentId={agent.id} detail={loaded} onOpenNote={select} />
                  </div>
                </div>
              )
            }
          </Async>
        )}
      </div>
    </div>
  );
}
