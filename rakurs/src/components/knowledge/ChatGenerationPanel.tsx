import { useEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { CommunicationStyleCard } from '@/components/knowledge/CommunicationStyleCard';
import { GenerationRunRail, mergeDelayedRunFirstPage, mergeRunPages } from '@/components/knowledge/GenerationRunRail';
import { ProposalWorkspace } from '@/components/knowledge/ProposalWorkspace';
import { useApi } from '@/hooks/useApi';
import { RecentHistoryPreparation } from './RecentHistoryPreparation';
import type { KbGenerationPreview, KbGenerationProposal, KbGenerationRunDetail, KbGenerationRunSummary } from '@/types';
import {
  appendGenerationDetailPage,
  generationView,
  initialGenerationState,
  isCurrentGenerationResponse,
  mergeRefreshedGenerationDetail,
  reduceGenerationState,
  type GenerationDetailCollection,
} from './generation-state';

export const localMidnight = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function scheduleGenerationPolling({
  poll,
  isActive,
  onError = () => undefined,
  delayMs = 1_500,
}: {
  poll: () => Promise<void>;
  isActive: () => boolean;
  onError?: (error: unknown) => void;
  delayMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped || !isActive()) return;
    timer = setTimeout(() => {
      if (stopped || !isActive()) return;
      void poll()
        .catch((error) => {
          if (!stopped && isActive()) onError(error);
        })
        .finally(() => {
          if (!stopped && isActive()) schedule();
        });
    }, delayMs);
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export class GenerationRunTarget {
  constructor(private runId: string | null) {}

  get current(): string | null {
    return this.runId;
  }

  switchTo(runId: string | null): void {
    this.runId = runId;
  }

  isCurrent(runId: string): boolean {
    return this.runId === runId;
  }

  async loadCurrent<T>(load: (runId: string) => Promise<T>): Promise<T | null> {
    const runId = this.runId;
    return runId === null ? null : load(runId);
  }
}

export const generationDetailErrorPresentation = (
  status: KbGenerationRunDetail['run']['status'] | undefined,
): { automatic: boolean; retryLabel: string | null } => {
  const automatic = status === 'queued' || status === 'running';
  return { automatic, retryLabel: automatic ? null : 'Повторить загрузку' };
};

export function ChatGenerationPanel({
  agentId,
  initialRunId,
  onRunId,
  readOnly = false,
  mode = 'drafts',
}: {
  agentId: string;
  initialRunId: string | null;
  onRunId: (runId: string | null) => void;
  readOnly?: boolean;
  mode?: 'drafts' | 'runs';
}) {
  const [state, dispatch] = useReducer(reduceGenerationState, initialGenerationState({ conversationIds: [], from: '', to: '' }));
  const requestKey = useRef<{ previewId: string; key: string } | null>(null);
  const epoch = useRef(0);
  const actionAbort = useRef<AbortController | null>(null);
  const runTarget = useRef(new GenerationRunTarget(initialRunId));
  const detailSnapshot = useRef<KbGenerationRunDetail | null>(null);
  const loadingCollections = useRef(new Set<GenerationDetailCollection>());
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(initialRunId !== null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadedRuns, setLoadedRuns] = useState<KbGenerationRunSummary[] | null>(null);
  const [runsCursor, setRunsCursor] = useState<string | null | undefined>(undefined);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runPageError, setRunPageError] = useState<string | null>(null);
  const [collectionLoading, setCollectionLoading] = useState<GenerationDetailCollection[]>([]);
  const [collectionErrors, setCollectionErrors] = useState<Partial<Record<GenerationDetailCollection, string>>>({});
  const runs = useApi((signal) => api.listKnowledgeGenerationRuns(agentId, undefined, signal), [agentId]);
  const view = generationView(state);
  const visibleRuns = loadedRuns ?? runs.data?.items ?? [];
  const nextRunsCursor = runsCursor === undefined ? runs.data?.nextCursor ?? null : runsCursor;
  detailSnapshot.current = state.detail;

  useEffect(() => () => actionAbort.current?.abort(), []);
  useEffect(() => {
    setLoadedRuns(null);
    setRunsCursor(undefined);
  }, [agentId]);

  useEffect(() => {
    if (!runs.data) return;
    const firstPage = runs.data.items;
    setLoadedRuns((current) => current === null
      ? firstPage
      : mergeDelayedRunFirstPage(current, firstPage));
  }, [runs.data]);

  async function loadRun(runId: string, signal?: AbortSignal, polling = false, preserveLoadedPages = false) {
    const startedAt = epoch.current;
    if (!polling) setDetailLoading(true);
    try {
      const detail = await api.getKnowledgeGenerationRun(agentId, runId, signal);
      if (!isCurrentGenerationResponse(startedAt, runId, epoch.current, runTarget.current.current)) return detail;
      const currentDetail = detailSnapshot.current;
      const nextDetail = preserveLoadedPages && currentDetail?.run.id === runId
        ? mergeRefreshedGenerationDetail(currentDetail, detail)
        : detail;
      detailSnapshot.current = nextDetail;
      dispatch({ type: polling ? 'poll' : 'run', detail: nextDetail });
      setLoadedRuns((current) => mergeRunPages(current ?? visibleRuns, [nextDetail.run]));
      setDetailError(null);
      return detail;
    } finally {
      if (!polling && startedAt === epoch.current) setDetailLoading(false);
    }
  }

  useEffect(() => {
    epoch.current += 1;
    runTarget.current.switchTo(initialRunId);
    detailSnapshot.current = null;
    dispatch({ type: 'run_requested' });
    setDetailError(null);
    if (!initialRunId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadRun(initialRunId, controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setDetailError(api.humanError(caught));
    });
    return () => controller.abort();
  }, [agentId, initialRunId]);

  useEffect(() => {
    const run = state.detail?.run;
    if (!run || run.id !== initialRunId || (run.status !== 'queued' && run.status !== 'running')) return;
    const controller = new AbortController();
    const stop = scheduleGenerationPolling({
      poll: async () => { await loadRun(run.id, controller.signal, true, true); },
      isActive: () => {
        const current = detailSnapshot.current?.run;
        return !controller.signal.aborted && runTarget.current.isCurrent(run.id)
          && current?.id === run.id && (current.status === 'queued' || current.status === 'running');
      },
      onError: (caught) => {
        if (!controller.signal.aborted) setDetailError(api.humanError(caught));
      },
    });
    return () => {
      stop();
      controller.abort();
    };
  }, [agentId, initialRunId, state.detail?.run.id]);

  async function start(preview: KbGenerationPreview) {
    if (busy || readOnly) return;
    setBusy(true);
    setActionError(null);
    const startedAt = epoch.current;
    actionAbort.current?.abort();
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      if (requestKey.current?.previewId !== preview.previewId) requestKey.current = { previewId: preview.previewId, key: crypto.randomUUID() };
      const run = await api.startKnowledgeGeneration(agentId, { previewId: preview.previewId, requestKey: requestKey.current.key }, controller.signal);
      if (startedAt !== epoch.current) return;
      const summary: KbGenerationRunSummary = {
        ...run,
        classificationCounts: { customer: 0, irrelevant: 0, uncertain: 0 },
        excludedBatchCount: 0,
        errors: [],
        drafts: [],
        draftsNextCursor: null,
      };
      setLoadedRuns((current) => [summary, ...(current ?? visibleRuns).filter((item) => item.id !== summary.id)]);
      epoch.current += 1;
      runTarget.current.switchTo(run.id);
      onRunId(run.id);
    } catch (caught) {
      setActionError(api.humanError(caught));
    } finally {
      setBusy(false);
    }
  }

  function selectRun(runId: string) {
    if (runTarget.current.isCurrent(runId)) {
      void reloadSelectedRun();
      return;
    }
    epoch.current += 1;
    runTarget.current.switchTo(runId);
    setDetailError(null);
    setActionError(null);
    onRunId(runId);
  }

  async function reloadSelectedRun() {
    const runId = runTarget.current.current;
    if (!runId || detailLoading) return;
    try {
      await runTarget.current.loadCurrent((targetRunId) => loadRun(targetRunId, undefined, false, true));
    } catch (caught) {
      if (runTarget.current.isCurrent(runId)) setDetailError(api.humanError(caught));
    }
  }

  async function loadMoreRuns() {
    if (!nextRunsCursor || loadingRuns) return;
    setLoadingRuns(true);
    setRunPageError(null);
    try {
      const page = await api.listKnowledgeGenerationRuns(agentId, nextRunsCursor);
      setLoadedRuns((current) => mergeRunPages(current ?? visibleRuns, page.items));
      setRunsCursor(page.nextCursor);
    } catch (caught) {
      setRunPageError(api.humanError(caught));
    } finally {
      setLoadingRuns(false);
    }
  }

  async function action(kind: 'cancel' | 'retry') {
    if (!state.detail || readOnly) return;
    setBusy(true);
    setActionError(null);
    try {
      const run = kind === 'cancel'
        ? await api.cancelKnowledgeGenerationRun(agentId, state.detail.run.id)
        : await api.retryKnowledgeGenerationRun(agentId, state.detail.run.id);
      await loadRun(run.id, undefined, false, true);
    } catch (caught) {
      setActionError(api.humanError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadCollection(collection: GenerationDetailCollection) {
    const current = state.detail;
    if (!current || loadingCollections.current.has(collection)) return current;
    const cursor = collectionCursor(current, collection);
    if (cursor === null && !(collection === 'rawFindings' && current.rawFindings === undefined)) return current;
    loadingCollections.current.add(collection);
    setCollectionLoading((items) => items.includes(collection) ? items : [...items, collection]);
    setCollectionErrors((errors) => ({ ...errors, [collection]: undefined }));
    const startedAt = epoch.current;
    try {
      const next = await api.getKnowledgeGenerationRun(agentId, current.run.id, undefined, collectionOptions(collection, cursor ?? undefined));
      if (!isCurrentGenerationResponse(startedAt, current.run.id, epoch.current, runTarget.current.current)) return current;
      dispatch({ type: 'append_page', detail: next, collection });
      return appendGenerationDetailPage(current, next, collection);
    } catch (caught) {
      if (startedAt === epoch.current) setCollectionErrors((errors) => ({ ...errors, [collection]: api.humanError(caught) }));
      return current;
    } finally {
      loadingCollections.current.delete(collection);
      if (startedAt === epoch.current) setCollectionLoading((items) => items.filter((item) => item !== collection));
    }
  }

  async function loadAllProposals(): Promise<KbGenerationProposal[]> {
    let detail = state.detail;
    if (!detail) return [];
    let cursor = detail.proposals.nextCursor;
    while (cursor) {
      const startedAt = epoch.current;
      const next = await api.getKnowledgeGenerationRun(agentId, detail.run.id, undefined, { proposalCursor: cursor });
      if (!isCurrentGenerationResponse(startedAt, detail.run.id, epoch.current, runTarget.current.current)) return detail.proposals.items;
      detail = appendGenerationDetailPage(detail, next, 'proposals');
      dispatch({ type: 'append_page', detail: next, collection: 'proposals' });
      cursor = detail.proposals.nextCursor;
    }
    return detail.proposals.items;
  }

  const reset = () => {
    epoch.current += 1;
    runTarget.current.switchTo(null);
    requestKey.current = null;
    dispatch({ type: 'reset' });
    setDetailError(null);
    setActionError(null);
    onRunId(null);
  };

  return (
    <div className="knowledge-review-grid">
      <GenerationRunRail
        runs={visibleRuns}
        activeRunId={initialRunId}
        loading={runs.loading}
        error={runs.error}
        hasMore={nextRunsCursor !== null}
        loadingMore={loadingRuns}
        onSelect={selectRun}
        onRetry={runs.reload}
        onLoadMore={() => void loadMoreRuns()}
        loadMoreError={runPageError}
        onRetryLoadMore={() => void loadMoreRuns()}
      />

      <section className="generation-review" aria-label={mode === 'runs' ? 'Сведения о запуске' : 'Проверка черновика'}>
        <header className="generation-review__head">
          <div>
            <p className="knowledge-kicker">{mode === 'runs' ? 'Сведения и аудит' : 'Новая версия'}</p>
            <h2>{mode === 'runs' ? 'Выбранный запуск' : 'Черновики из переписки'}</h2>
          </div>
          {state.detail && <div><span className="mono">{new Date(state.detail.run.createdAt).toLocaleString('ru-RU')}</span><small>{statusLabel(state.detail.run.status)}</small></div>}
        </header>

        {detailLoading && !state.detail && <div className="generation-review__skeleton" role="status" aria-label="Загружаем запуск"><span /><span /><span /></div>}
        {!detailLoading && !state.detail && detailError && (
          <div className="knowledge-inline-state knowledge-inline-state--error" role="alert">
            <p>Не удалось загрузить запуск.</p>
            <span>{detailError}</span>
            <button type="button" className="btn-sm" disabled={detailLoading} onClick={() => void reloadSelectedRun()}>{detailLoading ? 'Обновляем…' : 'Повторить загрузку'}</button>
          </div>
        )}
        {!detailLoading && !state.detail && !detailError && (
          <div className="generation-review__prepare">
            {!readOnly ? <RecentHistoryPreparation agentId={agentId} busy={busy} onStart={(preview) => void start(preview)} />
              : <div className="knowledge-inline-state"><p>Выберите запуск слева.</p><span>Участники могут просматривать предложения, источники и черновики.</span></div>}
          </div>
        )}

        {state.detail && (
          <>
            <RunStatus detail={state.detail} />
            <div className="generation-review__actions">
              {view === 'active' && !readOnly && <button type="button" className="btn-sm" disabled={busy || state.detail.run.cancelRequestedAt !== null} onClick={() => void action('cancel')}>Отменить после текущего запроса</button>}
              {state.detail.run.status === 'failed' && !readOnly && <button type="button" className="btn-sm" disabled={busy} onClick={() => void action('retry')}>Повторить незавершённые пакеты</button>}
              <button type="button" className="btn-quiet" onClick={reset}>Подготовить заново</button>
            </div>
            {(view === 'review' || view === 'empty' || view === 'partial_failure' || (view === 'cancelled' && state.detail.run.proposalCount > 0)) && (
              <ProposalWorkspace
                agentId={agentId}
                detail={state.detail}
                readOnly={readOnly}
                onChanged={(proposal) => dispatch({ type: 'proposal_updated', proposal })}
                onLoadAllProposals={loadAllProposals}
                onLoadMoreProposals={() => void loadCollection('proposals')}
                onLoadMoreExclusions={() => void loadCollection('exclusions')}
                onLoadRawFindings={() => void loadCollection('rawFindings')}
                onLoadMoreRawFindings={() => void loadCollection('rawFindings')}
                collectionState={{
                  proposals: { loading: collectionLoading.includes('proposals'), error: collectionErrors.proposals, onRetry: () => void loadCollection('proposals') },
                  exclusions: { loading: collectionLoading.includes('exclusions'), error: collectionErrors.exclusions, onRetry: () => void loadCollection('exclusions') },
                  rawFindings: { loading: collectionLoading.includes('rawFindings'), error: collectionErrors.rawFindings, onRetry: () => void loadCollection('rawFindings') },
                }}
              />
            )}
            {view === 'active' && <div className="knowledge-inline-state"><p>Обработка продолжается.</p><span>Новые пакеты и стоимость обновляются автоматически.</span></div>}
            {view === 'cancelled' && state.detail.run.proposalCount === 0 && <div className="knowledge-inline-state"><p>Обработка отменена.</p><span>Ничего не опубликовано.</span></div>}
          </>
        )}
        {state.detail && detailError && (
          <div role="alert" className="generation-review__error">
            <span>{detailError}</span>
            {generationDetailErrorPresentation(state.detail.run.status).automatic ? (
              <span>Повторяем автоматически, пока запуск активен.</span>
            ) : (
              <button type="button" className="btn-sm" disabled={detailLoading} onClick={() => void reloadSelectedRun()}>
                {detailLoading ? 'Обновляем…' : generationDetailErrorPresentation(state.detail.run.status).retryLabel}
              </button>
            )}
          </div>
        )}
        {actionError && <div role="alert" className="generation-review__error">{actionError}</div>}
      </section>

      <aside className="knowledge-review-aside" aria-label="Настройки и черновики">
        <CommunicationStyleCard agentId={agentId} readOnly={readOnly} />
        <RunDraftShortcuts
          drafts={state.detail?.drafts ?? []}
          hasMore={state.detail?.draftsNextCursor !== null && state.detail?.draftsNextCursor !== undefined}
          loading={collectionLoading.includes('drafts')}
          error={collectionErrors.drafts}
          onLoadMore={() => void loadCollection('drafts')}
        />
      </aside>
    </div>
  );
}

function RunStatus({ detail }: { detail: KbGenerationRunDetail }) {
  const { run } = detail;
  const skipped = run.counts.skippedAiOrSystem + run.counts.skippedUnsupported + run.counts.skippedEmpty
    + run.counts.skippedSensitive + run.counts.skippedOversize + run.counts.skippedNoSeller;
  return (
    <section className="generation-review__status" aria-label="Статус запуска">
      <dl className="generation-review__metrics">
        <div><dt>Пакеты</dt><dd>{run.completedBatchCount}/{run.batchCount}</dd></div>
        <div><dt>Предложения</dt><dd>{run.proposalCount}</dd></div>
        <div><dt>Пропущено</dt><dd>{skipped + run.excludedBatchCount}</dd></div>
        <div><dt>Токены / стоимость</dt><dd>{run.usage.promptTokens + run.usage.completionTokens} / ${run.usage.cost}</dd></div>
      </dl>
      <p className="generation-review__notice">Стоимость отдельных запросов может отсутствовать; точный счёт хранит AI-провайдер.</p>
      {run.errors.length > 0 && <p className="generation-review__notice generation-review__notice--error">Ошибок: {run.errors.length}. Готовые предложения сохранены.</p>}
    </section>
  );
}

function RunDraftShortcuts({ drafts, hasMore, loading, error, onLoadMore }: { drafts: KbGenerationRunDetail['drafts']; hasMore: boolean; loading: boolean; error?: string; onLoadMore: () => void }) {
  return (
    <section className="generation-drafts" aria-labelledby="generation-drafts-title">
      <p className="knowledge-kicker">Результаты запуска</p>
      <h2 id="generation-drafts-title">Все черновики</h2>
      {drafts.length === 0 ? <p className="generation-drafts__empty">У этого запуска пока нет черновиков. Ничего не опубликовано.</p> : (
        <ol className="generation-drafts__list">
          {drafts.map((draft) => <li key={draft.id}><Link to={`../drafts/${draft.id}`}><b>{draft.title}</b><span>{new Date(draft.createdAt).toLocaleDateString('ru-RU')} · {draftStatus(draft.status)}</span></Link></li>)}
        </ol>
      )}
      {error && <div className="knowledge-collection-error" role="alert"><span>{error}</span><button type="button" className="btn-sm" onClick={onLoadMore}>Повторить</button></div>}
      {hasMore && <button type="button" className="knowledge-load-more" disabled={loading} onClick={onLoadMore}>{loading ? 'Загружаем черновики…' : 'Показать ещё черновики'}</button>}
    </section>
  );
}

function collectionCursor(detail: KbGenerationRunDetail, collection: GenerationDetailCollection): string | null | undefined {
  if (collection === 'proposals') return detail.proposals.nextCursor;
  if (collection === 'drafts') return detail.draftsNextCursor;
  if (collection === 'exclusions') return detail.exclusionsNextCursor;
  return detail.rawFindingsNextCursor;
}

function collectionOptions(collection: GenerationDetailCollection, cursor?: string): api.KnowledgeGenerationRunPageOptions {
  if (collection === 'proposals') return { proposalCursor: cursor };
  if (collection === 'drafts') return { draftCursor: cursor };
  if (collection === 'exclusions') return { exclusionCursor: cursor };
  return { rawFindingCursor: cursor, includeRawFindings: true };
}

const draftStatus = (status: KbGenerationRunDetail['drafts'][number]['status']) => ({ open: 'на проверке', applied: 'применён', discarded: 'отклонён' })[status];
const statusLabel = (status: KbGenerationRunDetail['run']['status']): string => ({ queued: 'В очереди', running: 'Обработка', completed: 'Завершён', failed: 'Ошибка', cancelled: 'Отменён' })[status];
