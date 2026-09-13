import { useEffect, useReducer, useRef, useState, type SetStateAction } from 'react';
import * as api from '@/api';
import { mergeDelayedRunFirstPage, mergeRunPages } from '@/components/knowledge/GenerationRunRail';
import { useApi } from '@/hooks/useApi';
import type { KbGenerationPreview, KbGenerationProposal, KbGenerationRunDetail, KbGenerationRunSummary } from '@/types';
import {
  appendGenerationDetailPage,
  generationView,
  initialGenerationState,
  isCurrentGenerationResponse,
  mergeRefreshedGenerationDetail,
  reduceGenerationState,
  type GenerationDetailCollection,
  type GenerationUiState,
  type GenerationView,
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

export const generationRunErrorPresentation = (
  error: KbGenerationRunSummary['errors'][number],
): { reason: string; recovery: string } => {
  const prefix = error.ordinal === null ? '' : `Часть ${error.ordinal + 1}: `;
  switch (error.code) {
    case 'missing_ai_configuration':
      return {
        reason: 'Не сохранён API-ключ OpenRouter.',
        recovery: 'Откройте настройки ИИ, сохраните ключ и повторите разбор.',
      };
    case 'invalid_ai_configuration':
      return {
        reason: 'Сохранённый API-ключ OpenRouter не удалось прочитать.',
        recovery: 'Сохраните ключ заново в настройках ИИ и повторите разбор.',
      };
    case 'provider_error':
    case 'batch_failed':
      return {
        reason: `${prefix}AI-провайдер не ответил.`,
        recovery: 'Проверьте ключ и баланс у провайдера, затем повторите разбор.',
      };
    case 'consolidation_failed':
      return {
        reason: 'Не удалось собрать итоговые предложения.',
        recovery: 'Повторите разбор: сохранённые находки будут использованы без повторной обработки чатов.',
      };
    case 'slot_timeout':
      return {
        reason: 'Сервис ИИ был занят слишком долго.',
        recovery: 'Подождите немного и повторите разбор.',
      };
    case 'attempts_exhausted':
      return {
        reason: `${prefix}повторные попытки исчерпаны.`,
        recovery: 'Начните новый разбор для выбранных чатов.',
      };
    case 'interrupted':
      return {
        reason: `${prefix}обработка прервалась при перезапуске сервера.`,
        recovery: 'Повторите разбор: готовые части не будут обрабатываться заново.',
      };
    case 'malformed_output':
    case 'invalid_output':
    case 'unsafe_output':
      return {
        reason: `${prefix}AI-провайдер вернул непригодный ответ.`,
        recovery: 'Повторите разбор; небезопасный текст не был добавлен.',
      };
    default:
      return {
        reason: `${prefix}обработка завершилась с ошибкой (${error.code}).`,
        recovery: 'Повторите разбор. Если ошибка повторится, сообщите код поддержке.',
      };
  }
};

function useRunScopedState<T>(scope: object, initialValue: T) {
  const [stored, setStored] = useState({ scope, value: initialValue });
  const current = stored.scope === scope;
  // Reset during render so no committed frame exposes another run's UI state.
  if (!current) setStored({ scope, value: initialValue });
  const setValue = (value: SetStateAction<T>) => {
    setStored((previous) => {
      // Async callbacks retain their original scope, even after A -> B -> A.
      if (previous.scope !== scope) return previous;
      return { scope, value: typeof value === 'function' ? (value as (previous: T) => T)(previous.value) : value };
    });
  };
  return [current ? stored.value : initialValue, setValue] as const;
}

export interface GenerationRunController {
  state: GenerationUiState;
  view: GenerationView;
  detail: KbGenerationRunDetail | null;
  busy: boolean;
  detailLoading: boolean;
  detailError: string | null;
  actionError: string | null;
  runs: {
    items: KbGenerationRunSummary[];
    loading: boolean;
    error: unknown;
    hasMore: boolean;
    loadingMore: boolean;
    pageError: string | null;
    reload: () => void;
    loadMore: () => Promise<void>;
  };
  start: (preview: KbGenerationPreview) => Promise<void>;
  selectRun: (runId: string) => void;
  reloadSelectedRun: () => Promise<void>;
  action: (kind: 'cancel' | 'retry') => Promise<void>;
  loadCollection: (collection: GenerationDetailCollection) => Promise<KbGenerationRunDetail | null>;
  loadAllProposals: () => Promise<KbGenerationProposal[]>;
  reset: () => void;
  onProposalChanged: (proposal: KbGenerationProposal) => void;
  collectionLoading: GenerationDetailCollection[];
  collectionErrors: Partial<Record<GenerationDetailCollection, string>>;
}

/**
 * Everything a chat-generation run needs on screen: the selected run's detail and polling,
 * the run history pages, start/cancel/retry, and paged collections. Every piece of state is
 * scoped to the (agent, run) pair so nothing from run A survives a switch to run B.
 */
export function useGenerationRun({
  agentId,
  initialRunId,
  onRunId,
  readOnly,
}: {
  agentId: string;
  initialRunId: string | null;
  onRunId: (runId: string | null) => void;
  readOnly: boolean;
}): GenerationRunController {
  const [storedState, dispatch] = useReducer(reduceGenerationState, initialGenerationState({ conversationIds: [], from: '', to: '' }));
  // Route changes must hide stale detail before the passive run_requested effect.
  const state = storedState.detail && storedState.detail.run.id !== initialRunId
    ? { ...storedState, detail: null }
    : storedState;
  const requestKey = useRef<{ previewId: string; key: string } | null>(null);
  const epoch = useRef(0);
  const actionAbort = useRef<AbortController | null>(null);
  const runTarget = useRef(new GenerationRunTarget(initialRunId));
  const detailSnapshot = useRef<KbGenerationRunDetail | null>(null);
  const runScope = useRef({ agentId, runId: initialRunId, loadingCollections: new Set<GenerationDetailCollection>() });
  if (runScope.current.agentId !== agentId || runScope.current.runId !== initialRunId) {
    runScope.current = { agentId, runId: initialRunId, loadingCollections: new Set<GenerationDetailCollection>() };
  }
  const scope = runScope.current;
  const loadingCollections = scope.loadingCollections;
  const [busy, setBusy] = useRunScopedState(scope, false);
  const [detailLoading, setDetailLoading] = useRunScopedState(scope, initialRunId !== null);
  const [detailError, setDetailError] = useRunScopedState<string | null>(scope, null);
  const [actionError, setActionError] = useRunScopedState<string | null>(scope, null);
  const [loadedRuns, setLoadedRuns] = useState<KbGenerationRunSummary[] | null>(null);
  const [runsCursor, setRunsCursor] = useState<string | null | undefined>(undefined);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runPageError, setRunPageError] = useState<string | null>(null);
  const [collectionLoading, setCollectionLoading] = useRunScopedState<GenerationDetailCollection[]>(scope, []);
  const [collectionErrors, setCollectionErrors] = useRunScopedState<Partial<Record<GenerationDetailCollection, string>>>(scope, {});
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
    if (!current || loadingCollections.has(collection)) return current;
    const cursor = collectionCursor(current, collection);
    if (cursor === null && !(collection === 'rawFindings' && current.rawFindings === undefined)) return current;
    loadingCollections.add(collection);
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
      loadingCollections.delete(collection);
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

  return {
    state,
    view,
    detail: state.detail,
    busy,
    detailLoading,
    detailError,
    actionError,
    runs: {
      items: visibleRuns,
      loading: runs.loading,
      error: runs.error,
      hasMore: nextRunsCursor !== null,
      loadingMore: loadingRuns,
      pageError: runPageError,
      reload: runs.reload,
      loadMore: loadMoreRuns,
    },
    start,
    selectRun,
    reloadSelectedRun,
    action,
    loadCollection,
    loadAllProposals,
    reset,
    onProposalChanged: (proposal) => dispatch({ type: 'proposal_updated', proposal }),
    collectionLoading,
    collectionErrors,
  };
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

export const generationDraftStatusLabel = (status: KbGenerationRunDetail['drafts'][number]['status']) => ({ open: 'на проверке', applied: 'применён', discarded: 'отклонён' })[status];
export const generationStatusLabel = (status: KbGenerationRunDetail['run']['status']): string => ({ queued: 'В очереди', running: 'Обработка', completed: 'Завершён', failed: 'Ошибка', cancelled: 'Отменён' })[status];
