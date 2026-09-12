import { useEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { GenerationReview } from '@/components/knowledge/GenerationReview';
import { Card } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { RecentHistoryPreparation } from './RecentHistoryPreparation';
import { GenerationDraftLinks } from './GenerationDraftLinks';
import type { KbGenerationPreview, KbGenerationRunDetail } from '@/types';
import { generationView, initialGenerationState, isCurrentGenerationResponse, mergeRefreshedGenerationDetail, reduceGenerationState } from './generation-state';

export const localMidnight = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function ChatGenerationPanel({
  agentId,
  initialRunId,
  onRunId,
  readOnly = false,
}: {
  agentId: string;
  initialRunId: string | null;
  onRunId: (runId: string | null) => void;
  readOnly?: boolean;
}) {
  const [state, dispatch] = useReducer(
    reduceGenerationState,
    initialGenerationState({ conversationIds: [], from: '', to: '' }),
  );
  const requestKey = useRef<{ previewId: string; key: string } | null>(null);
  const epoch = useRef(0);
  const actionAbort = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(initialRunId);
  const loadingMore = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runs = useApi((signal) => api.listKnowledgeGenerationRuns(agentId, undefined, signal), [agentId]);
  const view = generationView(state);

  useEffect(() => () => actionAbort.current?.abort(), []);

  async function loadRun(runId: string, signal?: AbortSignal, polling = false, preserveLoadedPages = false) {
    const startedAt = epoch.current;
    const detail = await api.getKnowledgeGenerationRun(agentId, runId, signal);
    if (!isCurrentGenerationResponse(startedAt, runId, epoch.current, activeRunId.current)) return detail;
    const nextDetail = preserveLoadedPages && state.detail?.run.id === runId
      ? mergeRefreshedGenerationDetail(state.detail, detail)
      : detail;
    dispatch({ type: polling ? 'poll' : 'run', detail: nextDetail });
    return detail;
  }

  useEffect(() => {
    epoch.current += 1;
    activeRunId.current = initialRunId;
    if (!initialRunId) return;
    const controller = new AbortController();
    void loadRun(initialRunId, controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(api.humanError(caught));
    });
    return () => controller.abort();
  }, [agentId, initialRunId]);

  useEffect(() => {
    const run = state.detail?.run;
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    const controller = new AbortController();
    let timer = 0;
    const poll = () => {
      timer = window.setTimeout(() => {
        void loadRun(run.id, controller.signal, true)
          .then(() => setError(null))
          .catch((caught) => {
            if (!controller.signal.aborted) {
              setError(api.humanError(caught));
              poll();
            }
          });
      }, 1_500);
    };
    poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [agentId, state.detail]);

  async function start(preview: KbGenerationPreview) {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    const startedAt = epoch.current;
    actionAbort.current?.abort();
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      if (requestKey.current?.previewId !== preview.previewId) {
        requestKey.current = { previewId: preview.previewId, key: crypto.randomUUID() };
      }
      const run = await api.startKnowledgeGeneration(agentId, {
        previewId: preview.previewId,
        requestKey: requestKey.current.key,
      }, controller.signal);
      if (startedAt !== epoch.current) return;
      epoch.current += 1;
      activeRunId.current = run.id;
      onRunId(run.id);
    } catch (caught) {
      setError(api.humanError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function action(kind: 'cancel' | 'retry') {
    if (!state.detail) return;
    setBusy(true);
    try {
      const run = kind === 'cancel'
        ? await api.cancelKnowledgeGenerationRun(agentId, state.detail.run.id)
        : await api.retryKnowledgeGenerationRun(agentId, state.detail.run.id);
      await loadRun(run.id);
    } catch (caught) {
      setError(api.humanError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreProposals() {
    const current = state.detail;
    const cursor = current?.proposals.nextCursor;
    if (!current || !cursor || loadingMore.current) return;
    loadingMore.current = true;
    const startedAt = epoch.current;
    setBusy(true);
    try {
      const next = await api.getKnowledgeGenerationRun(agentId, current.run.id, undefined, cursor);
      if (!isCurrentGenerationResponse(startedAt, current.run.id, epoch.current, activeRunId.current)) return;
      dispatch({ type: 'append_page', detail: next });
    } catch (caught) {
      if (startedAt === epoch.current) setError(api.humanError(caught));
    } finally {
      loadingMore.current = false;
      if (startedAt === epoch.current) setBusy(false);
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700 }}>База знаний и скрипт из WhatsApp</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>Из реальной переписки — в черновики для вашей проверки.</div>
        </div>
        {state.detail && <button type="button" className="btn-sm" onClick={() => { epoch.current += 1; activeRunId.current = null; requestKey.current = null; dispatch({ type: 'reset' }); onRunId(null); }}>Подготовить заново</button>}
      </div>

      {!state.detail && (
        <div style={{ marginTop: 14 }}>
          {!readOnly && <RecentHistoryPreparation agentId={agentId} busy={busy} onStart={preview => void start(preview)} />}
          {(runs.data?.items.length ?? 0) > 0 && (
            <div style={{ marginTop: 12, fontSize: 12 }}>
              <div style={{ color: 'var(--text-dim)', marginBottom: 5 }}>Предыдущие запуски</div>
              {runs.data!.items.slice(0, 5).map((run) => (
                <button key={run.id} type="button" className="btn-link" style={{ display: 'block', marginTop: 4 }} onClick={() => { epoch.current += 1; activeRunId.current = run.id; onRunId(run.id); }}>
                  {new Date(run.createdAt).toLocaleString('ru-RU')} · {statusLabel(run.status)} · {run.proposalCount}
                </button>
              ))}
            </div>
          )}
          {readOnly && (runs.data?.items.length ?? 0) === 0 && <EmptyState>Запусков обработки пока нет.</EmptyState>}
        </div>
      )}

      {state.detail && (
        <div style={{ marginTop: 14 }}>
          <RunStatus detail={state.detail} />
          {state.detail.run.status === 'completed' && state.detail.drafts && <GenerationDraftLinks drafts={state.detail.drafts} />}
          {view === 'active' && !readOnly && <button type="button" className="btn-sm" disabled={busy || state.detail.run.cancelRequestedAt !== null} onClick={() => void action('cancel')}>Отменить после текущего запроса</button>}
          {(view === 'review' || view === 'empty' || view === 'partial_failure' || (view === 'cancelled' && state.detail.run.proposalCount > 0)) && <details open={state.detail.run.status !== 'completed'} style={{ marginTop: 12 }}>
            <summary>Предложения и источники из переписки</summary>
            <GenerationReview agentId={agentId} detail={state.detail} readOnly={readOnly} onChanged={(proposal) => dispatch({ type: 'proposal_updated', proposal })} />
            {state.detail.proposals.nextCursor && <button type="button" className="btn-sm" disabled={busy} onClick={() => void loadMoreProposals()}>Показать ещё предложения</button>}
          </details>}
          {state.detail.run.status === 'failed' && !readOnly && <><div style={{ color: 'var(--warning)', fontSize: 12, marginTop: 8 }}>Предыдущий незавершённый запрос мог быть тарифицирован провайдером.</div><button type="button" className="btn-sm" disabled={busy} onClick={() => void action('retry')}>Повторить незавершённые пакеты</button></>}
          {view === 'cancelled' && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Обработка отменена. Уже завершившийся запрос мог быть тарифицирован, его предложения не добавлены.</div>}
        </div>
      )}
      {error && <div role="alert" style={{ color: 'var(--danger)', marginTop: 10, fontSize: 12 }}>{error}{!readOnly && <> · <Link to="../settings">Настроить AI</Link></>}</div>}
    </Card>
  );
}

function RunStatus({ detail }: { detail: KbGenerationRunDetail }) {
  const { run } = detail;
  return (
    <div style={{ fontSize: 12, marginBottom: 10 }}>
      Статус: {statusLabel(run.status)} · пакетов {run.completedBatchCount}/{run.batchCount} · предложений {run.proposalCount} · токенов {run.usage.promptTokens + run.usage.completionTokens} · учтённая стоимость ${run.usage.cost}
      <div style={{ color: 'var(--text-dim)' }}>Провайдер может не вернуть стоимость отдельных запросов; точный счёт смотрите в его кабинете.</div>
      {run.status === 'failed' && <div style={{ color: 'var(--danger)' }}>Часть обработки не завершена. Готовые предложения сохранены.</div>}
    </div>
  );
}

const statusLabel = (status: KbGenerationRunDetail['run']['status']): string => ({
  queued: 'в очереди',
  running: 'обработка',
  completed: 'завершено',
  failed: 'ошибка',
  cancelled: 'отменено',
})[status];
