import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { GenerationReview } from '@/components/knowledge/GenerationReview';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { ConversationSummary, KbGenerationRunDetail } from '@/types';
import { generationView, initialGenerationState, isCurrentGenerationResponse, mergeRefreshedGenerationDetail, reduceGenerationState } from './generation-state';

export const localDateInput = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const initialFrom = () => localDateInput(new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000));
const initialTo = () => localDateInput(new Date(Date.now() + 24 * 60 * 60 * 1_000));
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
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [state, dispatch] = useReducer(
    reduceGenerationState,
    initialGenerationState({ conversationIds: [], from: localMidnight(from) ?? '', to: localMidnight(to) ?? '' }),
  );
  const requestKey = useRef<string | null>(null);
  const epoch = useRef(0);
  const actionAbort = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(initialRunId);
  const loadingMore = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversations = useApi<ConversationSummary[]>((signal) => api.listConversations(agentId, signal), [agentId]);
  const runs = useApi((signal) => api.listKnowledgeGenerationRuns(agentId, undefined, signal), [agentId]);
  const view = generationView(state);

  const selection = useMemo(() => ({
    conversationIds: state.selection.conversationIds,
    from: localMidnight(from) ?? '',
    to: localMidnight(to) ?? '',
  }), [state.selection.conversationIds, from, to]);

  useEffect(() => {
    epoch.current += 1;
    actionAbort.current?.abort();
    requestKey.current = null;
    dispatch({ type: 'selection', selection });
  }, [selection]);

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

  function toggleConversation(id: string) {
    const current = state.selection.conversationIds;
    dispatch({
      type: 'selection',
      selection: { ...selection, conversationIds: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] },
    });
  }

  async function preview() {
    const startedAt = epoch.current;
    actionAbort.current?.abort();
    const controller = new AbortController();
    actionAbort.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await api.previewKnowledgeGeneration(agentId, selection, controller.signal);
      if (startedAt !== epoch.current) return;
      requestKey.current = crypto.randomUUID();
      dispatch({ type: 'preview', preview: next });
    } catch (caught) {
      setError(api.humanError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!state.preview) return;
    setBusy(true);
    setError(null);
    const startedAt = epoch.current;
    actionAbort.current?.abort();
    const controller = new AbortController();
    actionAbort.current = controller;
    try {
      const run = await api.startKnowledgeGeneration(agentId, {
        previewId: state.preview.previewId,
        requestKey: requestKey.current ?? (requestKey.current = crypto.randomUUID()),
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
          <div style={{ fontWeight: 700 }}>{readOnly ? 'Знания из диалогов' : 'Создать знания из диалогов'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>{readOnly ? 'Просматривайте результаты обработки и источники предложений.' : 'Вы выбираете переписки, проверяете каждое предложение и публикуете только через черновик.'}</div>
        </div>
        {state.detail && <button type="button" className="btn-sm" onClick={() => { epoch.current += 1; activeRunId.current = null; dispatch({ type: 'reset' }); onRunId(null); }}>Новая выборка</button>}
      </div>

      {!state.detail && (
        <div style={{ marginTop: 14 }}>
          {!readOnly && <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label>С <input type="date" disabled={busy} value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>До <input type="date" disabled={busy} value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <Async state={conversations} skeleton={<Skeleton height={100} />} compactError>
            {(items) => items.length === 0 ? <EmptyState>Сохранённых диалогов пока нет.</EmptyState> : (
              <div style={{ maxHeight: 190, overflowY: 'auto', marginTop: 10 }}>
                {items.map((conversation) => (
                  <label key={conversation.id} style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
                    <input type="checkbox" disabled={busy} checked={state.selection.conversationIds.includes(conversation.id)} onChange={() => toggleConversation(conversation.id)} />
                    <span>{conversation.contactName ?? conversation.contactPhone} <span style={{ color: 'var(--text-dim)' }}>· {conversation.preview ?? 'Вложение'}</span></span>
                  </label>
                ))}
              </div>
            )}
          </Async>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 8 }}>Перед отправкой телефоны, email, платёжные реквизиты, адреса и номера заказов скрываются автоматически. Автоматическое скрытие не гарантирует полную анонимизацию.</div>
          {state.preview && (
            <div className="sunken-box" style={{ marginTop: 10, padding: 10, fontSize: 12 }}>
              Выбрано сообщений: {state.preview.counts.selectedMessages}; подходит: {state.preview.counts.eligibleMessages}; символов: {state.preview.counts.eligibleCharacters}; пакетов: {state.preview.batchCount}; запросов к модели: не больше {state.preview.maxCalls}; лимит ответа: {state.preview.maxOutputTokens} токенов. Модель: {state.preview.modelId}. Текст после скрытия данных будет отправлен настроенному AI-провайдеру.
              <div style={{ color: 'var(--text-dim)', marginTop: 5 }}>
                Пропущено: AI/системных — {state.preview.counts.skippedAiOrSystem}; неподдерживаемых — {state.preview.counts.skippedUnsupported}; пустых — {state.preview.counts.skippedEmpty}; чувствительных — {state.preview.counts.skippedSensitive}; сверх лимита — {state.preview.counts.skippedOversize}; без ответа продавца — {state.preview.counts.skippedNoSeller}.
                {state.preview.truncated && ' Объём ограничен лимитом обработки.'}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn-sm" disabled={busy || selection.conversationIds.length === 0 || !localMidnight(from) || !localMidnight(to) || from >= to} onClick={() => void preview()}>Проверить объём</button>
            {state.preview && <button type="button" className="btn" disabled={busy} onClick={() => void start()}>Начать обработку</button>}
          </div>
          </>}
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
          {view === 'active' && !readOnly && <button type="button" className="btn-sm" disabled={busy || state.detail.run.cancelRequestedAt !== null} onClick={() => void action('cancel')}>Отменить после текущего запроса</button>}
          {(view === 'review' || view === 'empty' || view === 'partial_failure' || (view === 'cancelled' && state.detail.run.proposalCount > 0)) && <GenerationReview agentId={agentId} detail={state.detail} readOnly={readOnly} onChanged={(proposal) => dispatch({ type: 'proposal_updated', proposal })} />}
          {state.detail.proposals.nextCursor && (
            <button type="button" className="btn-sm" disabled={busy} onClick={() => void loadMoreProposals()}>Показать ещё предложения</button>
          )}
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
