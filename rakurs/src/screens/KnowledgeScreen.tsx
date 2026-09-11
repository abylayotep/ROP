import { useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { Graph } from '@/components/knowledge/Graph';
import { ChatGenerationPanel } from '@/components/knowledge/ChatGenerationPanel';
import { ImportPanel } from '@/components/knowledge/ImportPanel';
import { NoteEditor } from '@/components/knowledge/NoteEditor';
import { buildTree, NoteTree } from '@/components/knowledge/NoteTree';
import { NotePanel } from '@/components/knowledge/NotePanel';
import { Card, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { KbGraph, KbNote, KbNoteDetail, KbNoteKind } from '@/types';

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

type View = 'notes' | 'graph';

const VIEWS: SegmentItem<View>[] = [
  { id: 'notes', label: 'Заметки' },
  { id: 'graph', label: 'Граф' },
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

  const [view, setView] = useState<View>('notes');

  const [params, setParams] = useSearchParams();
  const selected = params.get('note');
  const generationRun = params.get('generation');

  // Whether the one `NoteEditor` currently on screen has typed text it has not saved.
  // `NoteEditor` is keyed by `selected`, so moving `selected` at all remounts it — this is
  // the one flag standing between a click and a silently discarded draft.
  const [editorDirty, setEditorDirty] = useState(false);

  /** `false` means a dirty draft vetoed the navigation and asked the owner first. */
  const confirmDiscard = () =>
    !editorDirty || window.confirm('Уйти без сохранения? Несохранённые правки будут потеряны.');

  /** The actual navigation, with no question asked. For the paths that already answered
   * one — a save, a confirmed delete, an explicit «Отмена» — asking again would be asking
   * about a change that either no longer exists or was just discarded on purpose. */
  const selectNow = (noteId: string | null) =>
    noteId === null ? setParams({}, { replace: true }) : setParams({ note: noteId }, { replace: true });

  /**
   * The one guard every note-to-note jump goes through: the tree, a backlink, an outgoing
   * link, a search result, and «+ Новая заметка» all call this, never `selectNow` directly.
   * A dirty editor gets a chance to say no before its draft is gone for good.
   */
  const select = (noteId: string | null) => {
    if (!confirmDiscard()) return;
    selectNow(noteId);
  };

  /**
   * The graph tab's own node click. It goes through the exact same veto as `select` — a
   * click on a node is still a selection change, and the graph does not get to skip the
   * question just because it arrived from a canvas instead of the tree.
   */
  const openFromGraph = (noteId: string) => {
    if (!confirmDiscard()) return;
    selectNow(noteId);
    setView('notes');
  };

  /**
   * The tree's own source: the same ranker the agent uses when `search` is not empty, the
   * plain recent list otherwise. `GET /notes?q=` is what stage 5's agent calls, so this is
   * the owner's honest test of «would the agent find this note at all» — the same reason
   * the right pane's own search box exists.
   *
   * `kind` goes to the server too, not just `q`: both branches of that route narrow inside
   * their own query, before the search or browse cap is applied, so «Товары» is twenty
   * products, not what is left of twenty results after this screen threw the rest away.
   */
  const list = useApi<KbNote[]>(
    (signal) => api.listKbNotes(agent.id, { q: search || undefined, kind: kind === 'all' ? undefined : kind }, signal),
    [agent.id, search, kind],
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

  /**
   * The graph tab's own data, fetched only while that tab is open — same trick as `detail`
   * above with `NEW`: the fetcher answers `null` for the tab nobody is looking at, so
   * flipping to «Заметки» and back does not leave a stale request in flight, and flipping
   * to «Граф» always sees whatever the vault looks like right now.
   */
  const graph = useApi<KbGraph | null>(
    (signal) => (view === 'graph' ? api.getKbGraph(agent.id, signal) : Promise.resolve(null)),
    [agent.id, view],
  );

  /** A note was created, saved under a new path, or deleted — both lists may have moved. */
  function refreshLists() {
    list.reload();
    vault.reload();
  }

  const tree = useMemo(() => buildTree(list.data ?? []), [list.data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ChatGenerationPanel
          key={agent.id}
          agentId={agent.id}
          initialRunId={generationRun}
          onRunId={(runId) => {
            const next = new URLSearchParams(params);
            runId === null ? next.delete('generation') : next.set('generation', runId);
            setParams(next, { replace: true });
          }}
          readOnly={!owner}
        />
      <div className="knowledge-layout">
      <div className="knowledge-sidebar">
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
            <div className="knowledge-filters"><Segmented items={FILTERS} value={kind} onChange={setKind} size="sm" /></div>
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
        <div style={{ marginBottom: 14 }}>
          <Segmented items={VIEWS} value={view} onChange={setView} size="sm" />
        </div>

        {/*
         * Hidden with `display`, never unmounted: the graph tab and the note tab share this
         * column, and switching tabs must not throw away an editor draft the way removing
         * `NoteEditor` from the tree would. The dirty guard already covers every path that
         * actually changes `selected` — a tab flip on its own does not, so it needs none of
         * its own.
         */}
        <div style={{ display: view === 'notes' ? 'block' : 'none' }}>
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
              // «Отмена» already means «throw this away» — asking again would be asking about
              // a discard the owner just asked for.
              onCancel={() => selectNow(null)}
              onSaved={(saved) => {
                refreshLists();
                // The save just answered the question the guard exists to ask.
                selectNow(saved.id);
              }}
              onDeleted={() => selectNow(null)}
              onOpenNote={select}
              onDirtyChange={setEditorDirty}
            />
          )}

          {selected !== null && selected !== NEW && (
            <Async state={detail} skeleton={<Skeleton height={420} />}>
              {(loaded) =>
                loaded && (
                  <div className="knowledge-detail">
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
                          // The confirm inside `remove()` already asked; this is not a second
                          // navigation the owner needs to approve again.
                          selectNow(null);
                        }}
                        onOpenNote={select}
                        onDirtyChange={setEditorDirty}
                      />
                    </div>
                    <div className="knowledge-context">
                      <NotePanel key={selected} agentId={agent.id} detail={loaded} onOpenNote={select} />
                    </div>
                  </div>
                )
              }
            </Async>
          )}
        </div>

        <div style={{ display: view === 'graph' ? 'block' : 'none' }}>
          <Card>
            <Async state={graph} skeleton={<Skeleton height={560} />}>
              {(loaded) => loaded && <Graph graph={loaded} onOpenNote={openFromGraph} />}
            </Async>
          </Card>
        </div>
      </div>
      </div>
    </div>
  );
}
