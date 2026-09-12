import type { KbGenerationRunSummary } from '@/types';

const STATUS: Record<KbGenerationRunSummary['status'], string> = {
  queued: 'В очереди',
  running: 'Обработка',
  completed: 'Завершён',
  failed: 'Ошибка',
  cancelled: 'Отменён',
};

export function mergeRunPages(
  current: readonly KbGenerationRunSummary[],
  next: readonly KbGenerationRunSummary[],
): KbGenerationRunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of next) byId.set(run.id, run);
  return [...byId.values()];
}

export function mergeDelayedRunFirstPage(
  current: readonly KbGenerationRunSummary[],
  firstPage: readonly KbGenerationRunSummary[],
): KbGenerationRunSummary[] {
  const currentById = new Map(current.map((run) => [run.id, run]));
  const firstPageIds = new Set(firstPage.map((run) => run.id));
  const merged = [
    ...firstPage.map((run) => {
      const existing = currentById.get(run.id);
      return existing && existing.updatedAt >= run.updatedAt ? existing : run;
    }),
    ...current.filter((run) => !firstPageIds.has(run.id)),
  ];
  return merged.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function GenerationRunRail({
  runs,
  activeRunId,
  loading,
  error,
  hasMore,
  loadingMore,
  onSelect,
  onRetry,
  onLoadMore,
  loadMoreError,
  onRetryLoadMore,
}: {
  runs: readonly KbGenerationRunSummary[];
  activeRunId: string | null;
  loading: boolean;
  error?: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (runId: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  loadMoreError?: string | null;
  onRetryLoadMore?: () => void;
}) {
  return (
    <aside className="generation-rail" aria-label="История запусков">
      <div className="generation-rail__head">
        <div>
          <p className="knowledge-kicker">История</p>
          <h2>Запуски</h2>
        </div>
        <span className="generation-count">{runs.length}</span>
      </div>

      {loading && runs.length === 0 && (
        <div className="generation-rail__skeleton" role="status" aria-label="Загружаем запуски">
          <span /><span /><span />
        </div>
      )}
      {error !== undefined && runs.length === 0 && (
        <div className="knowledge-inline-state knowledge-inline-state--error" role="alert">
          <p>Не удалось загрузить историю.</p>
          <button type="button" className="btn-sm" onClick={onRetry}>Повторить</button>
        </div>
      )}
      {!loading && error === undefined && runs.length === 0 && (
        <div className="knowledge-inline-state">
          <p>Запусков пока нет.</p>
          <span>Новая обработка появится здесь и останется в истории.</span>
        </div>
      )}

      {runs.length > 0 && (
        <ol className="generation-run-list">
          {runs.map((run) => {
            const active = run.id === activeRunId;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className="generation-run"
                  aria-pressed={active}
                  onClick={() => onSelect(run.id)}
                >
                  <span className="generation-run__topline">
                    <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}</time>
                    <span className={`generation-status generation-status--${run.status}`}>{STATUS[run.status]}</span>
                  </span>
                  <span className="generation-run__time">{new Date(run.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="generation-run__metrics">
                    <span><b>{run.proposalCount}</b> предложений</span>
                    <span><b>{run.completedBatchCount}/{run.batchCount}</b> пакетов</span>
                  </span>
                  <span className="generation-run__foot">
                    <span>{run.drafts.length} черн.</span>
                    <span>{run.classificationCounts.customer} клиентских</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore && (
        <button type="button" className="generation-rail__more" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? 'Загружаем…' : 'Показать ещё запусков'}
        </button>
      )}
      {loadMoreError && runs.length > 0 && (
        <div className="generation-rail__page-error" role="alert">
          <span>{loadMoreError}</span>
          <button type="button" className="generation-rail__retry" onClick={onRetryLoadMore ?? onLoadMore}>Повторить</button>
        </div>
      )}
    </aside>
  );
}
