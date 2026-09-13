import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { Graph } from '@/components/knowledge/Graph';
import { NoteEditor } from '@/components/knowledge/NoteEditor';
import { buildTree, NoteTree, type TreeNode } from '@/components/knowledge/NoteTree';
import { NotePanel } from '@/components/knowledge/NotePanel';
import { Card, Segmented, type SegmentItem } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { KbGraph, KbNote, KbNoteDetail, KbNoteKind } from '@/types';

/**
 * «Знания»: the vault — a folder tree, a markdown editor, and a panel of what points where.
 *
 * Three panes, three concerns. The tree (left) only ever has to answer «which notes, and
 * where» — search and the kind filter both narrow it, but neither one owns a note's text.
 * The editor (centre) only ever shows or edits one note's body. The panel (right) only ever
 * answers questions *about* the open note: what links here, what it links to, what the
 * agent would retrieve for it. Nothing here filters what the agent sees — that already
 * happened server-side, in what got imported and what got written; this tab reads and
 * edits the same store, honestly.
 */

/** Not a real note id — every note id is a uuid the server minted, and this string never
 * collides with one. Marks the centre pane as "a blank note, not yet saved". */
const NEW = 'new';

/** Mirrors `LIST_LIMIT` in `server/src/api/knowledge.ts`. Browsing is capped, not paged. */
const LIST_LIMIT = 100;
/** Mirrors `SEARCH_LIMIT` there: a search answers with the best twenty and stops. */
const SEARCH_LIMIT = 20;

/** Chat generation writes the sales script under this folder; the tree names it for people. */
const SCRIPT_FOLDER = 'Скрипт';

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

/** Relabels the top-level script folder; paths stay untouched so selection and links still work. */
export function labelScriptFolder(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) =>
    node.path === SCRIPT_FOLDER && node.children.length > 0 ? { ...node, name: 'Скрипт продаж' } : node);
}

export function KnowledgeTab({ onDirtyChange, onTeach }: { onDirtyChange: (dirty: boolean) => void; onTeach: () => void }) {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const [kind, setKind] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  // Debounced so a word typed into the box is one search, not six.
  const search = useDebounced(query).trim();

  const [view, setView] = useState<View>('notes');

  const [params, setParams] = useSearchParams();
  const selected = params.get('note');

  // Whether the one `NoteEditor` currently on screen has typed text it has not saved.
  // `NoteEditor` is keyed by `selected`, so moving `selected` at all remounts it — this is
  // the one flag standing between a click and a silently discarded draft. The screen gets a
  // copy so a tab change can ask the same question.
  const [editorDirty, setEditorDirtyState] = useState(false);
  const setEditorDirty = (dirty: boolean) => {
    setEditorDirtyState(dirty);
    onDirtyChange(dirty);
  };

  /** `false` means a dirty draft vetoed the navigation and asked the owner first. */
  const confirmDiscard = () =>
    !editorDirty || window.confirm('Уйти без сохранения? Несохранённые правки будут потеряны.');

  /** The actual navigation, with no question asked. For the paths that already answered
   * one — a save, a confirmed delete, an explicit «Отмена» — asking again would be asking
   * about a change that either no longer exists or was just discarded on purpose. */
  const selectNow = (noteId: string | null) => {
    const next = new URLSearchParams(params);
    if (noteId === null) next.delete('note');
    else next.set('note', noteId);
    next.set('tab', 'knowledge');
    setParams(next, { replace: true });
  };

  /**
   * The one guard every note-to-note jump goes through: the tree, a backlink, an outgoing
   * link, a search result, and «+ Новая заметка» all call this, never `selectNow` directly.
   */
  const select = (noteId: string | null) => {
    if (!confirmDiscard()) return;
    selectNow(noteId);
  };

  /** The graph's own node click goes through the exact same veto as `select`. */
  const openFromGraph = (noteId: string) => {
    if (!confirmDiscard()) return;
    selectNow(noteId);
    setView('notes');
  };

  /**
   * The tree's own source: the same ranker the agent uses when `search` is not empty, the
   * plain recent list otherwise. `kind` goes to the server too, so «Товары» is twenty
   * products, not what is left of twenty results after this tab threw the rest away.
   */
  const list = useApi<KbNote[]>(
    (signal) => api.listKbNotes(agent.id, { q: search || undefined, kind: kind === 'all' ? undefined : kind }, signal),
    [agent.id, search, kind],
  );

  /**
   * A second, always-unfiltered fetch, purely for titles: `[[` autocomplete and a wiki
   * link's «is this broken» both need every title in the vault, not the ones the current
   * search matched. Capped at `LIST_LIMIT`, same as the plain list.
   */
  const vault = useApi<KbNote[]>((signal) => api.listKbNotes(agent.id, {}, signal), [agent.id]);
  const titles = useMemo(() => new Set(vault.data?.map((n) => n.title) ?? []), [vault.data]);

  const detail = useApi<KbNoteDetail | null>(
    (signal) =>
      selected && selected !== NEW ? api.getKbNote(agent.id, selected, signal) : Promise.resolve(null),
    [agent.id, selected],
  );

  /** Fetched only while the graph view is open, so flipping back never leaves a stale request. */
  const graph = useApi<KbGraph | null>(
    (signal) => (view === 'graph' ? api.getKbGraph(agent.id, signal) : Promise.resolve(null)),
    [agent.id, view],
  );

  /** A note was created, saved under a new path, or deleted — both lists may have moved. */
  function refreshLists() {
    list.reload();
    vault.reload();
  }

  const tree = useMemo(() => labelScriptFolder(buildTree(list.data ?? [])), [list.data]);

  return (
    <>
      <p className="training-tab__intro">Что агент знает о товарах, ценах и порядке работы. Агент отвечает только из этого.</p>
      <section className="knowledge-notes-layout" aria-label="Опубликованные знания">
        <div className="knowledge-sidebar">
          <Card pad={false}>
            <div className="knowledge-sidebar__controls">
              <input
                value={query}
                type="search"
                aria-label="Поиск по базе знаний"
                placeholder="Вопрос клиента"
                onChange={(e) => setQuery(e.target.value)}
                className="knowledge-control"
              />
              <div className="knowledge-filters"><Segmented items={FILTERS} value={kind} onChange={setKind} size="sm" /></div>
              {owner && <button type="button" className="btn-sm" onClick={() => select(NEW)}>+ Новая заметка</button>}
            </div>
            <div className="knowledge-sidebar__tree">
              <Async state={list} skeleton={<Skeleton height={220} />} compactError>
                {() => tree.length === 0 ? (
                  <EmptyState>
                    {search !== '' ? `По запросу «${search}» ничего не нашлось. ИИ ответил бы так же.`
                      : kind !== 'all' ? 'Заметок этого типа пока нет.'
                        : owner ? (
                          <>
                            <p style={{ margin: '0 0 12px' }}>База знаний пуста. Агенту пока нечем отвечать.</p>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                              <button type="button" className="btn btn-sm" onClick={onTeach}>Научить из переписки</button>
                              <button type="button" className="btn-sm" onClick={() => select(NEW)}>Создать заметку</button>
                            </div>
                          </>
                        )
                          : 'База знаний пуста. Отвечать агенту пока нечем.'}
                  </EmptyState>
                ) : (
                  <>
                    <NoteTree nodes={tree} selectedId={selected} onSelect={select} />
                    {search === '' && (list.data?.length ?? 0) >= LIST_LIMIT && <div className="knowledge-list-limit">Показаны {LIST_LIMIT} последних заметок — остальные находятся поиском.</div>}
                    {search !== '' && (list.data?.length ?? 0) >= SEARCH_LIMIT && <div className="knowledge-list-limit">Показаны {SEARCH_LIMIT} самых подходящих заметок. Уточните запрос, если нужной среди них нет.</div>}
                  </>
                )}
              </Async>
            </div>
          </Card>
        </div>

        <div className="knowledge-notes-main">
          <div className="knowledge-view-switcher"><Segmented items={VIEWS} value={view} onChange={setView} size="sm" /></div>
          <div className={view === 'notes' ? '' : 'knowledge-view-panel--hidden'}>
            {selected === null && <Card><EmptyState>Выберите заметку слева или создайте новую.</EmptyState></Card>}
            {selected === NEW && owner && (
              <NoteEditor key={NEW} agentId={agent.id} detail={null} titles={titles}
                onCancel={() => selectNow(null)}
                onSaved={(saved) => { refreshLists(); selectNow(saved.id); }}
                onDeleted={() => selectNow(null)} onOpenNote={select} onDirtyChange={setEditorDirty} />
            )}
            {selected !== null && selected !== NEW && (
              <Async state={detail} skeleton={<Skeleton height={420} />}>
                {(loaded) => loaded && (
                  <div className="knowledge-detail">
                    <div className="knowledge-note-main">
                      <NoteEditor key={selected} agentId={agent.id} detail={loaded} titles={titles}
                        onSaved={() => { refreshLists(); detail.reload(); }}
                        onDeleted={() => { refreshLists(); selectNow(null); }}
                        onOpenNote={select} onDirtyChange={setEditorDirty} />
                    </div>
                    <div className="knowledge-context"><NotePanel key={selected} agentId={agent.id} detail={loaded} onOpenNote={select} /></div>
                  </div>
                )}
              </Async>
            )}
          </div>
          <div className={view === 'graph' ? '' : 'knowledge-view-panel--hidden'}>
            <Card><Async state={graph} skeleton={<Skeleton height={560} />}>{(loaded) => loaded && <Graph graph={loaded} onOpenNote={openFromGraph} />}</Async></Card>
          </div>
        </div>
      </section>
    </>
  );
}
