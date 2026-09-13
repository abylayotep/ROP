import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { tabAfterKey } from '@/components/knowledge/KnowledgeWorkspace';
import { useToast } from '@/components/ui/Toast';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type {
  KbGenerationProposal,
  KbGenerationProposalKind,
  KbGenerationRunDetail,
} from '@/types';

const WARNING: Record<string, string> = {
  dated: 'Может быть устаревшим',
  conflict: 'Есть противоречие',
  context_limited: 'Не хватает контекста',
};

const CLASSIFICATION: Record<string, string> = {
  irrelevant: 'Не относится к клиентам',
  uncertain: 'Недостаточно данных',
};

type ProposalUpdate = typeof api.updateKnowledgeGenerationProposal;
type ProposalPatch = { path?: string; body?: string; status?: 'pending' | 'rejected' };
type DraftCreate = typeof api.createKnowledgeGenerationDraft;
const MAX_SELECTED_PROPOSALS = 20;

export interface ProposalCollectionState {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export const reconcileDraftField = (current: string, previousServer: string, nextServer: string): string =>
  current === previousServer ? nextServer : current;

export const planVisibleSelection = (
  proposals: readonly KbGenerationProposal[],
  kind: KbGenerationProposalKind,
  limit = MAX_SELECTED_PROPOSALS,
  visibleIds?: ReadonlySet<string>,
): KbGenerationProposal[] => {
  const selected = proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected).length;
  const remaining = Math.max(0, limit - selected);
  return proposals
    .filter((proposal) => proposal.kind === kind && proposal.status === 'pending' && !proposal.selected && (!visibleIds || visibleIds.has(proposal.id)))
    .slice(0, remaining);
};

export const planClearSelection = (proposals: readonly KbGenerationProposal[]): KbGenerationProposal[] =>
  proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected);

export const canAddSelection = (
  proposals: readonly KbGenerationProposal[],
  proposal: KbGenerationProposal,
  limit = MAX_SELECTED_PROPOSALS,
): boolean => proposal.selected || proposals.filter((item) => item.status === 'pending' && item.selected).length < limit;

export class ProposalMutationQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly latestById = new Map<string, KbGenerationProposal>();

  remember(proposal: KbGenerationProposal, replaceEqual = false): void {
    const current = this.latestById.get(proposal.id);
    if (!current || proposal.revision > current.revision || (replaceEqual && proposal.revision === current.revision)) {
      this.latestById.set(proposal.id, proposal);
    }
  }

  latest(proposalId: string): KbGenerationProposal | undefined {
    return this.latestById.get(proposalId);
  }

  run<T>(proposalId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(proposalId);
    const current = previous ? previous.catch(() => undefined).then(mutation) : mutation();
    this.pending.set(proposalId, current);
    return current.finally(() => {
      if (this.pending.get(proposalId) === current) this.pending.delete(proposalId);
    });
  }

  runProposal(
    proposal: KbGenerationProposal,
    mutation: (latest: KbGenerationProposal) => Promise<KbGenerationProposal>,
  ): Promise<KbGenerationProposal> {
    this.remember(proposal);
    return this.run(proposal.id, async () => {
      const committed = await mutation(this.latestById.get(proposal.id) ?? proposal);
      this.remember(committed, true);
      return committed;
    });
  }
}

export const patchGenerationProposal = (
  agentId: string,
  proposal: KbGenerationProposal,
  values: ProposalPatch,
  update: ProposalUpdate = api.updateKnowledgeGenerationProposal,
) => update(agentId, proposal.id, { revision: proposal.revision, ...values });

export function createDraftFromPersistedSelection(
  agentId: string,
  runId: string,
  proposals: readonly KbGenerationProposal[],
  targets: Readonly<Record<string, string>>,
  create: DraftCreate = api.createKnowledgeGenerationDraft,
) {
  const chosen = proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected);
  if (chosen.length === 0) return Promise.resolve(null);
  if (chosen.length > MAX_SELECTED_PROPOSALS) {
    return Promise.reject(new Error(`В один черновик можно добавить не больше ${MAX_SELECTED_PROPOSALS} предложений`));
  }
  return create(agentId, runId, {
    proposalIds: chosen.map((proposal) => proposal.id),
    revisions: Object.fromEntries(chosen.map((proposal) => [proposal.id, proposal.revision])),
    updateTargets: Object.fromEntries(
      chosen.flatMap((proposal) => targets[proposal.id] ? [[proposal.id, targets[proposal.id]!]] : []),
    ),
  });
}

export async function persistProposalSelection({
  agentId,
  proposal,
  selected,
  update = api.updateKnowledgeGenerationProposal,
  onOptimistic,
  onCommitted,
  onRollback,
}: {
  agentId: string;
  proposal: KbGenerationProposal;
  selected: boolean;
  update?: ProposalUpdate;
  onOptimistic: (proposal: KbGenerationProposal) => void;
  onCommitted: (proposal: KbGenerationProposal) => void;
  onRollback: (proposal: KbGenerationProposal) => void;
}): Promise<KbGenerationProposal> {
  onOptimistic({ ...proposal, selected });
  try {
    const committed = await update(agentId, proposal.id, { revision: proposal.revision, selected });
    onCommitted(committed);
    return committed;
  } catch (error) {
    onRollback(proposal);
    throw error;
  }
}

export function ProposalWorkspace({
  agentId,
  detail,
  onChanged,
  onLoadAllProposals,
  onLoadMoreProposals,
  onLoadMoreExclusions,
  onLoadRawFindings,
  onLoadMoreRawFindings,
  collectionState = {},
  readOnly = false,
}: {
  agentId: string;
  detail: KbGenerationRunDetail;
  onChanged: (proposal: KbGenerationProposal) => void;
  onLoadAllProposals?: () => Promise<KbGenerationProposal[]>;
  onLoadMoreProposals?: () => void;
  onLoadMoreExclusions?: () => void;
  onLoadRawFindings?: () => void;
  onLoadMoreRawFindings?: () => void;
  collectionState?: Partial<Record<'proposals' | 'exclusions' | 'rawFindings', ProposalCollectionState>>;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [kind, setKind] = useState<KbGenerationProposalKind>('knowledge');
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [updating, setUpdating] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [optimisticSelections, setOptimisticSelections] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const mutationQueue = useRef(new ProposalMutationQueue());
  const selectionLock = useRef(false);
  const proposals = useMemo(() => detail.proposals.items.map((proposal) => (
    optimisticSelections[proposal.id] === undefined
      ? proposal
      : { ...proposal, selected: optimisticSelections[proposal.id]! }
  )), [detail.proposals.items, optimisticSelections]);
  const visible = useMemo(() => proposals.filter((proposal) => proposal.kind === kind), [kind, proposals]);
  const selectedCount = proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected).length;
  const visibleEligible = visible.filter((proposal) => proposal.status === 'pending');

  useEffect(() => {
    for (const proposal of detail.proposals.items) mutationQueue.current.remember(proposal);
  }, [detail.proposals.items]);

  const setProposalBlocked = useCallback((proposalId: string, isBlocked: boolean) => {
    setBlocked((current) => isBlocked
      ? current.includes(proposalId) ? current : [...current, proposalId]
      : current.filter((id) => id !== proposalId));
  }, []);

  const setProposalUpdating = useCallback((proposalId: string, isUpdating: boolean) => {
    setUpdating((current) => isUpdating
      ? current.includes(proposalId) ? current : [...current, proposalId]
      : current.filter((id) => id !== proposalId));
  }, []);

  async function persistSelection(proposal: KbGenerationProposal, selected: boolean) {
    setProposalUpdating(proposal.id, true);
    setOptimisticSelections((current) => ({ ...current, [proposal.id]: selected }));
    const optimistic = { ...(mutationQueue.current.latest(proposal.id) ?? proposal), selected };
    mutationQueue.current.remember(optimistic, true);
    try {
      const committed = await mutationQueue.current.runProposal(optimistic, (latest) => (
        api.updateKnowledgeGenerationProposal(agentId, proposal.id, { revision: latest.revision, selected })
      ));
      onChanged(committed);
      return committed;
    } catch (error) {
      mutationQueue.current.remember(proposal, true);
      toast.fail(error, 'Не удалось сохранить выбор. Предыдущее состояние восстановлено.');
      return null;
    } finally {
      setOptimisticSelections((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      setProposalUpdating(proposal.id, false);
    }
  }

  async function select(proposal: KbGenerationProposal, selected: boolean) {
    if (readOnly || proposal.status !== 'pending' || updating.includes(proposal.id) || selectionLock.current) return;
    selectionLock.current = true;
    setSelectionBusy(true);
    setUpdating((current) => [...current, proposal.id]);
    try {
      const complete = onLoadAllProposals ? await onLoadAllProposals() : proposals;
      const current = complete.find((item) => item.id === proposal.id) ?? proposal;
      if (selected && !canAddSelection(complete, current)) {
        toast.fail(new Error(`Можно выбрать не больше ${MAX_SELECTED_PROPOSALS} предложений`));
        return;
      }
      await persistSelection(current, selected);
    } catch (error) {
      toast.fail(error, 'Не удалось проверить сохранённый выбор.');
    } finally {
      setUpdating((current) => current.filter((id) => id !== proposal.id));
      selectionLock.current = false;
      setSelectionBusy(false);
    }
  }

  async function setVisibleSelection(selected: boolean) {
    if (readOnly || selectionLock.current) return;
    selectionLock.current = true;
    setSelectionBusy(true);
    try {
      const complete = onLoadAllProposals ? await onLoadAllProposals() : proposals;
      const changes = selected
        ? planVisibleSelection(complete, kind, MAX_SELECTED_PROPOSALS, new Set(visible.map((proposal) => proposal.id)))
        : planClearSelection(complete);
      for (const proposal of changes) await persistSelection(proposal, selected);
    } catch (error) {
      toast.fail(error, 'Не удалось проверить сохранённый выбор.');
    } finally {
      selectionLock.current = false;
      setSelectionBusy(false);
    }
  }

  async function updateProposal(proposal: KbGenerationProposal, values: ProposalPatch): Promise<boolean> {
    setProposalUpdating(proposal.id, true);
    try {
      const current = await mutationQueue.current.runProposal(proposal, (latest) => patchGenerationProposal(agentId, latest, values));
      onChanged(current);
      return true;
    } catch (error) {
      toast.fail(error);
      return false;
    } finally {
      setProposalUpdating(proposal.id, false);
    }
  }

  async function makeDraft() {
    if (readOnly || drafting || blocked.length > 0 || updating.length > 0) return;
    setDrafting(true);
    try {
      const complete = onLoadAllProposals ? await onLoadAllProposals() : proposals;
      const result = await createDraftFromPersistedSelection(agentId, detail.run.id, complete, targets);
      if (!result) return;
      navigate(`../drafts/${result.draftId}`);
    } catch (error) {
      toast.fail(error);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <section className="proposal-workspace" aria-label="Предложения запуска">
      <header className="proposal-workspace__header">
        <div>
          <p className="knowledge-kicker">Проверка предложений</p>
          <h2>{kind === 'knowledge' ? 'База знаний' : 'Скрипт продаж'}</h2>
        </div>
        <span className="proposal-workspace__selection">Выбрано <b>{selectedCount}</b></span>
      </header>

      <nav className="proposal-kind-tabs" role="tablist" aria-label="Тип предложений">
        {([
          ['knowledge', 'База знаний'],
          ['script', 'Скрипт продаж'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            id={`proposal-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={kind === id}
            aria-controls={`proposal-panel-${id}`}
            tabIndex={kind === id ? 0 : -1}
            onClick={() => setKind(id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              const next = tabAfterKey(['knowledge', 'script'], id, event.key);
              if (!next) return;
              event.preventDefault();
              setKind(next as KbGenerationProposalKind);
              document.getElementById(`proposal-tab-${next}`)?.focus();
            }}
          >
            <span>{label}</span>
            <b>{proposals.filter((proposal) => proposal.kind === id).length}</b>
          </button>
        ))}
      </nav>

      <div
        id={`proposal-panel-${kind}`}
        role="tabpanel"
        aria-labelledby={`proposal-tab-${kind}`}
      >
        {!readOnly && visibleEligible.length > 0 && (
          <div className="proposal-workspace__bulk" aria-label="Групповой выбор">
            <button type="button" className="btn-link" disabled={selectionBusy || updating.length > 0 || selectedCount >= MAX_SELECTED_PROPOSALS} onClick={() => void setVisibleSelection(true)}>
              Выбрать видимые
            </button>
            <button type="button" className="btn-link" disabled={selectionBusy || updating.length > 0 || selectedCount === 0} onClick={() => void setVisibleSelection(false)}>
              Очистить выбор во всём запуске
            </button>
            <span>{selectionBusy ? 'Сохраняем выбор…' : `Выбор сохраняется сразу · максимум ${MAX_SELECTED_PROPOSALS}`}</span>
          </div>
        )}

        {visible.length === 0 ? (
          <div className="knowledge-inline-state proposal-workspace__empty">
            <p>{kind === 'knowledge' ? 'Новых фактов для базы знаний нет.' : 'Новых фраз для скрипта продаж нет.'}</p>
            <span>Ничего не опубликовано автоматически.</span>
          </div>
        ) : (
          <div className="proposal-list">
            {visible.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                agentId={agentId}
                proposal={proposal}
                target={targets[proposal.id] ?? ''}
                updating={updating.includes(proposal.id)}
                selectionDisabled={selectionBusy || (selectedCount >= MAX_SELECTED_PROPOSALS && !proposal.selected)}
                editing={editingId === proposal.id}
                editingDisabled={editingId !== null && editingId !== proposal.id}
                onEdit={(editing) => setEditingId(editing ? proposal.id : null)}
                onSelect={(selected) => void select(proposal, selected)}
                onTarget={(noteId) => setTargets((current) => ({ ...current, [proposal.id]: noteId }))}
                onUpdate={(values) => updateProposal(proposal, values)}
                onBlocked={setProposalBlocked}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}

        {collectionState.proposals?.error && (
          <CollectionError message={collectionState.proposals.error} onRetry={collectionState.proposals.onRetry} />
        )}
        {detail.proposals.nextCursor && onLoadMoreProposals && (
          <button type="button" className="knowledge-load-more" disabled={collectionState.proposals?.loading} onClick={onLoadMoreProposals}>
            {collectionState.proposals?.loading ? 'Загружаем предложения…' : 'Показать ещё предложения'}
          </button>
        )}
      </div>

      {!readOnly && (
        <footer className="proposal-workspace__footer">
          <div>
            <b>Ничего не публикуется сразу</b>
            <span>Сначала откроется отдельный черновик для финальной проверки.</span>
          </div>
          <button
            type="button"
            className="btn-accent"
            disabled={drafting || selectionBusy || (selectedCount === 0 && detail.proposals.nextCursor === null) || blocked.length > 0 || updating.length > 0}
            onClick={() => void makeDraft()}
          >
            {drafting ? 'Собираем…' : selectedCount > 0 ? `Собрать новый черновик · ${selectedCount}` : 'Собрать новый черновик'}
          </button>
        </footer>
      )}

      <AuditSection
        detail={detail}
        onLoadMoreExclusions={onLoadMoreExclusions}
        onLoadRawFindings={onLoadRawFindings}
        onLoadMoreRawFindings={onLoadMoreRawFindings}
        collectionState={collectionState}
      />
    </section>
  );
}

function ProposalCard({
  agentId,
  proposal,
  target,
  updating,
  selectionDisabled,
  editing,
  editingDisabled,
  onEdit,
  onSelect,
  onTarget,
  onUpdate,
  onBlocked,
  readOnly,
}: {
  agentId: string;
  proposal: KbGenerationProposal;
  target: string;
  updating: boolean;
  selectionDisabled: boolean;
  editing: boolean;
  editingDisabled: boolean;
  onEdit: (editing: boolean) => void;
  onSelect: (selected: boolean) => void;
  onTarget: (noteId: string) => void;
  onUpdate: (values: ProposalPatch) => Promise<boolean>;
  onBlocked: (proposalId: string, blocked: boolean) => void;
  readOnly: boolean;
}) {
  const [path, setPath] = useState(proposal.path);
  const [body, setBody] = useState(proposal.body);
  const previousServer = useRef(proposal);
  const rejected = proposal.status === 'rejected';
  const editable = proposal.status === 'pending' && !readOnly;
  const dirty = path !== proposal.path || body !== proposal.body;

  useEffect(() => {
    const previous = previousServer.current;
    setPath((current) => reconcileDraftField(current, previous.path, proposal.path));
    setBody((current) => reconcileDraftField(current, previous.body, proposal.body));
    previousServer.current = proposal;
  }, [proposal]);

  useEffect(() => onBlocked(proposal.id, editing && dirty), [proposal.id, editing, dirty, onBlocked]);

  async function save(values: ProposalPatch) {
    if (await onUpdate(values)) onEdit(false);
  }

  function cancelEdit() {
    setPath(proposal.path);
    setBody(proposal.body);
    onEdit(false);
  }

  return (
    <article className={`proposal-card proposal-card--${proposal.status}`}>
      <header className="proposal-card__header">
        <div className="proposal-card__state">
          {!readOnly && proposal.status === 'pending' && (
            <label className="proposal-card__check">
              <input
                type="checkbox"
                aria-label={`Добавить ${proposal.path} в черновик`}
                checked={proposal.selected}
                disabled={!editable || updating || selectionDisabled}
                onChange={(event) => onSelect(event.target.checked)}
              />
              <span>{updating ? 'Сохраняем…' : 'Добавить'}</span>
            </label>
          )}
          {proposal.confidence === 'high' && proposal.status === 'pending' && <span className="proposal-confidence">Проверено источниками</span>}
          {proposal.status === 'drafted' && proposal.draftId && <Link className="btn-link" to={`../drafts/${proposal.draftId}`}>В черновике →</Link>}
          {proposal.status === 'applied' && proposal.noteId && <Link className="btn-link" to={`?note=${encodeURIComponent(proposal.noteId)}`}>Опубликовано в заметке →</Link>}
          {rejected && <span className="proposal-card__rejected">Отклонено</span>}
        </div>
        <span className="proposal-card__source-count">{proposal.sources.length} {sourceWord(proposal.sources.length)}</span>
      </header>

      {editing ? (
        <div className="proposal-card__editor">
          <label className="proposal-field">
            <span>Путь</span>
            <input aria-label="Путь заметки" value={path} disabled={!editable || updating} onChange={(event) => setPath(event.target.value)} />
          </label>
          <label className="proposal-field">
            <span>Текст</span>
            <textarea aria-label="Текст предложения" value={body} disabled={!editable || updating} onChange={(event) => setBody(event.target.value)} rows={4} />
          </label>
        </div>
      ) : (
        <div className="proposal-card__copy">
          <h3>{proposal.path}</h3>
          <p>{proposal.body}</p>
        </div>
      )}

      {proposal.warnings.length > 0 && (
        <div className="proposal-warnings" role="note">
          {proposal.warnings.map((warning) => <span key={warning}>{WARNING[warning] ?? warning}</span>)}
        </div>
      )}

      <div className="proposal-sources" aria-label="Источники предложения">
        {proposal.sources.map((source, index) => source.available ? (
          <Link key={source.messageId} to={`../dialogs?conversation=${encodeURIComponent(source.conversationId)}&message=${encodeURIComponent(source.messageId)}`}>
            Источник {index + 1} · {new Date(source.sentAt).toLocaleDateString('ru-RU')}
          </Link>
        ) : <span key={source.messageId}>Источник {index + 1} недоступен</span>)}
      </div>
      {proposal.sources.some((source) => source.excerpt) && (
        <details className="proposal-excerpts">
          <summary>Фрагменты переписки</summary>
          {proposal.sources.filter((source) => source.excerpt).map((source) => <blockquote key={source.messageId}>{source.excerpt}</blockquote>)}
        </details>
      )}

      {proposal.matches.length > 0 && (
        <label className="proposal-field proposal-field--compact">
          <span>Существующая заметка</span>
          <select value={target} disabled={!editable || updating} onChange={(event) => onTarget(event.target.value)}>
            <option value="">Создать новую</option>
            {proposal.matches.map((match) => <option key={match.noteId} value={match.noteId}>{match.path}{match.exact ? ' · точное совпадение' : ''}</option>)}
          </select>
        </label>
      )}
      {target && <ExistingNote agentId={agentId} noteId={target} />}

      {!readOnly && (editable || rejected) && (
        <footer className="proposal-card__actions">
          {editable && !editing && <button type="button" className="btn-sm" disabled={updating || editingDisabled} onClick={() => onEdit(true)}>Изменить</button>}
          {editable && editing && (
            <>
              <button type="button" className="btn-sm" disabled={updating || !dirty} onClick={() => void save({ path, body })}>Сохранить правки</button>
              <button type="button" className="btn-quiet" disabled={updating} onClick={cancelEdit}>Отмена</button>
            </>
          )}
          <button type="button" className="btn-quiet" disabled={updating || (editing && dirty)} onClick={() => void save({ status: rejected ? 'pending' : 'rejected' })}>
            {rejected ? 'Вернуть на проверку' : 'Отклонить'}
          </button>
        </footer>
      )}
    </article>
  );
}

function AuditSection({
  detail,
  onLoadMoreExclusions,
  onLoadRawFindings,
  onLoadMoreRawFindings,
  collectionState,
}: {
  detail: KbGenerationRunDetail;
  onLoadMoreExclusions?: () => void;
  onLoadRawFindings?: () => void;
  onLoadMoreRawFindings?: () => void;
  collectionState: Partial<Record<'proposals' | 'exclusions' | 'rawFindings', ProposalCollectionState>>;
}) {
  return (
    <section className="generation-audit" aria-labelledby="generation-audit-title">
      <header>
        <p className="knowledge-kicker">Аудит</p>
        <h3 id="generation-audit-title">Исключённые пакеты</h3>
      </header>
      {detail.exclusions.length === 0 ? (
        <p className="generation-audit__empty">Исключённых пакетов на загруженной странице нет.</p>
      ) : (
        <ol className="generation-exclusions">
          {detail.exclusions.map((exclusion) => (
            <li key={exclusion.batchId}>
              <span className="mono">#{exclusion.ordinal + 1}</span>
              <div><b>{CLASSIFICATION[exclusion.classification]}</b><p>{exclusion.reason}</p></div>
            </li>
          ))}
        </ol>
      )}
      {collectionState.exclusions?.error && (
        <CollectionError message={collectionState.exclusions.error} onRetry={collectionState.exclusions.onRetry} />
      )}
      {detail.exclusionsNextCursor && onLoadMoreExclusions && (
        <button type="button" className="knowledge-load-more" disabled={collectionState.exclusions?.loading} onClick={onLoadMoreExclusions}>
          {collectionState.exclusions?.loading ? 'Загружаем исключения…' : 'Показать ещё исключения'}
        </button>
      )}

      <details className="raw-findings">
        <summary>Исходные находки</summary>
        {detail.rawFindings === undefined ? (
          <button type="button" className="btn-sm" disabled={collectionState.rawFindings?.loading} onClick={onLoadRawFindings}>
            {collectionState.rawFindings?.loading ? 'Загружаем находки…' : 'Загрузить исходные находки'}
          </button>
        ) : detail.rawFindings.length === 0 ? (
          <p>Исходных находок нет.</p>
        ) : (
          <div className="raw-findings__list">
            {detail.rawFindings.map((finding) => (
              <article key={finding.id}>
                <b>{finding.path}</b>
                <p>{finding.body}</p>
                {finding.warnings.length > 0 && (
                  <div className="proposal-warnings" role="note">
                    {finding.warnings.map((warning) => <span key={warning}>{WARNING[warning] ?? warning}</span>)}
                  </div>
                )}
                <div className="proposal-sources" aria-label="Источники исходной находки">
                  {finding.sources.map((source, index) => source.available ? (
                    <Link key={source.messageId} to={`../dialogs?conversation=${encodeURIComponent(source.conversationId)}&message=${encodeURIComponent(source.messageId)}`}>
                      Источник {index + 1} · {new Date(source.sentAt).toLocaleDateString('ru-RU')}
                    </Link>
                  ) : <span key={source.messageId}>Источник {index + 1} недоступен</span>)}
                </div>
              </article>
            ))}
          </div>
        )}
        {collectionState.rawFindings?.error && (
          <CollectionError message={collectionState.rawFindings.error} onRetry={collectionState.rawFindings.onRetry} />
        )}
        {detail.rawFindingsNextCursor && onLoadMoreRawFindings && (
          <button type="button" className="knowledge-load-more" disabled={collectionState.rawFindings?.loading} onClick={onLoadMoreRawFindings}>
            {collectionState.rawFindings?.loading ? 'Загружаем находки…' : 'Показать ещё находки'}
          </button>
        )}
      </details>
    </section>
  );
}

function CollectionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="knowledge-collection-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="btn-sm" onClick={onRetry}>Повторить</button>}
    </div>
  );
}

function ExistingNote({ agentId, noteId }: { agentId: string; noteId: string }) {
  const note = useApi((signal) => api.getKbNote(agentId, noteId, signal), [agentId, noteId]);
  return (
    <Async state={note} skeleton={<Skeleton height={54} />} compactError>
      {(loaded) => <div className="proposal-existing-note"><b>Сейчас в заметке</b><p>{loaded.body}</p></div>}
    </Async>
  );
}

function sourceWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'источник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'источника';
  return 'источников';
}
