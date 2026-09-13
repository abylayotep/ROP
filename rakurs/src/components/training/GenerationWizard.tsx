import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import {
  generationDetailErrorPresentation,
  generationDraftStatusLabel,
  generationRunErrorPresentation,
  generationStatusLabel,
  useGenerationRun,
  type GenerationRunController,
} from '@/components/knowledge/ChatGenerationPanel';
import { communicationStyleLabel } from '@/components/knowledge/CommunicationStyleCard';
import { GenerationRunRail } from '@/components/knowledge/GenerationRunRail';
import { ProposalWorkspace } from '@/components/knowledge/ProposalWorkspace';
import { RecentHistoryPreparation } from '@/components/knowledge/RecentHistoryPreparation';
import { useApi } from '@/hooks/useApi';
import { wizardStep } from '@/lib/training-state';
import type { KbGenerationRunDetail } from '@/types';
import { WizardSteps } from './WizardSteps';

/**
 * «Научить» → «Из переписки WhatsApp»: chat generation as four derived steps — period,
 * processing, selection, draft. All run state lives in `useGenerationRun`; this component only
 * decides which step's body to show. Owner-only: `TrainingScreen` mounts it inside «Научить».
 */
export function GenerationWizard({
  agentId,
  initialRunId,
  onRunId,
  onOpenReplies,
}: {
  agentId: string;
  initialRunId: string | null;
  onRunId: (id: string | null) => void;
  onOpenReplies: () => void;
}) {
  const generation = useGenerationRun({ agentId, initialRunId, onRunId, readOnly: false });
  const { detail, detailLoading, detailError, actionError, runs } = generation;
  // «Отобрать ещё» belongs to one run: switching runs drops it without an effect.
  const [pickMoreRunId, setPickMoreRunId] = useState<string | null>(null);
  const pickMore = detail !== null && pickMoreRunId === detail.run.id;
  const step = wizardStep(detail, pickMore);
  // A linked run has no step until its detail arrives; «Период» would be a false start.
  const shownStep = detail === null && initialRunId !== null ? null : step;
  // The selection step's workspace owns the one «Подробности разбора» block; the metrics go inside it.
  const workspaceShown = detail !== null && step === 'selection'
    && !(detail.run.status === 'completed' && detail.run.proposalCount === 0);

  return (
    <div className="training-wizard">
      <WizardSteps current={shownStep} />

      {detailLoading && !detail && (
        <div className="generation-review__skeleton" role="status" aria-label="Загружаем разбор"><span /><span /><span /></div>
      )}
      {!detailLoading && !detail && detailError && (
        <div className="knowledge-inline-state knowledge-inline-state--error" role="alert">
          <p>Не удалось загрузить разбор.</p>
          <span>{detailError}</span>
          <button type="button" className="btn-sm" disabled={detailLoading} onClick={() => void generation.reloadSelectedRun()}>
            {detailLoading ? 'Обновляем…' : 'Повторить загрузку'}
          </button>
        </div>
      )}
      {!detailLoading && !detail && !detailError && (
        <section className="training-wizard__step" aria-label="Период">
          <StyleLine agentId={agentId} onOpenReplies={onOpenReplies} />
          <RecentHistoryPreparation agentId={agentId} busy={generation.busy} onStart={(preview) => void generation.start(preview)} />
        </section>
      )}

      {detail && (
        <>
          <RunBar generation={generation} detail={detail} />
          {step === 'processing' && <ProcessingStep generation={generation} detail={detail} />}
          {step === 'selection' && (
            <SelectionStep
              agentId={agentId}
              generation={generation}
              detail={detail}
              onBackToDrafts={detail.drafts.length > 0 ? () => setPickMoreRunId(null) : null}
            />
          )}
          {step === 'draft' && (
            <DraftStep generation={generation} detail={detail} onPickMore={() => setPickMoreRunId(detail.run.id)} />
          )}
        </>
      )}

      {detail && detailError && (
        <div role="alert" className="generation-review__error">
          <span>{detailError}</span>
          {generationDetailErrorPresentation(detail.run.status).automatic ? (
            <span>Повторяем автоматически, пока разбор идёт.</span>
          ) : (
            <button type="button" className="btn-sm" disabled={detailLoading} onClick={() => void generation.reloadSelectedRun()}>
              {detailLoading ? 'Обновляем…' : generationDetailErrorPresentation(detail.run.status).retryLabel}
            </button>
          )}
        </div>
      )}
      {actionError && <div role="alert" className="generation-review__error">{actionError}</div>}

      <details className="training-history" open={initialRunId === null && runs.items.length > 0}>
        <summary>История разборов ({runs.items.length})</summary>
        <GenerationRunRail
          runs={runs.items}
          activeRunId={initialRunId}
          loading={runs.loading}
          error={runs.error}
          hasMore={runs.hasMore}
          loadingMore={runs.loadingMore}
          onSelect={generation.selectRun}
          onRetry={runs.reload}
          onLoadMore={() => void runs.loadMore()}
          loadMoreError={runs.pageError}
          onRetryLoadMore={() => void runs.loadMore()}
        />
      </details>

      {detail && !workspaceShown && (
        <details className="generation-details">
          <summary>Подробности разбора</summary>
          <RunMetrics detail={detail} />
        </details>
      )}
    </div>
  );
}

/** Step ①'s one line about the style replies will be drafted in; changing it is «Как отвечает». */
function StyleLine({ agentId, onOpenReplies }: { agentId: string; onOpenReplies: () => void }) {
  const style = useApi((signal) => api.getCommunicationStyle(agentId, signal), [agentId]);
  return (
    <p className="training-wizard__style">
      Стиль ответов: {style.data ? communicationStyleLabel(style.data.preset) : '…'} ·{' '}
      <button type="button" className="btn-link" onClick={onOpenReplies}>Изменить</button>
    </p>
  );
}

/** Date, status, the run's mapped errors, and the actions that apply to a finished run. */
function RunBar({ generation, detail }: { generation: GenerationRunController; detail: KbGenerationRunDetail }) {
  const { run } = detail;
  const active = run.status === 'queued' || run.status === 'running';
  return (
    <header className="training-wizard__run">
      <div>
        <span className="mono">{new Date(run.createdAt).toLocaleString('ru-RU')}</span>{' '}
        <small>{generationStatusLabel(run.status)}</small>
      </div>
      {run.errors.length > 0 && (
        <div className="generation-review__notice generation-review__notice--error" role="alert">
          {run.errors.map((error, index) => {
            const presentation = generationRunErrorPresentation(error);
            return <p key={`${error.batchId ?? 'run'}:${error.code}:${index}`}><strong>{presentation.reason}</strong> {presentation.recovery}</p>;
          })}
        </div>
      )}
      {!active && (
        <div className="generation-review__actions">
          {run.status === 'failed' && (
            <button type="button" className="btn-sm" disabled={generation.busy} onClick={() => void generation.action('retry')}>Повторить</button>
          )}
          <button type="button" className="btn-quiet" onClick={generation.reset}>Начать заново</button>
        </div>
      )}
    </header>
  );
}

function ProcessingStep({ generation, detail }: { generation: GenerationRunController; detail: KbGenerationRunDetail }) {
  const { run } = detail;
  if (run.status === 'queued' || run.status === 'running') {
    const percent = run.batchCount > 0 ? Math.floor((run.completedBatchCount * 100) / run.batchCount) : 0;
    return (
      <section className="training-wizard__step" aria-label="Разбор">
        <p>Разбираем переписку — {percent}%</p>
        <progress max={run.batchCount} value={run.completedBatchCount} />
        <button
          type="button"
          className="btn-sm"
          disabled={generation.busy || run.cancelRequestedAt !== null}
          onClick={() => void generation.action('cancel')}
        >
          Отменить
        </button>
      </section>
    );
  }
  return (
    <section className="training-wizard__step" aria-label="Разбор">
      <div className="knowledge-inline-state">
        <p>{run.status === 'cancelled' ? 'Разбор отменён.' : 'Разбор завершился с ошибкой.'}</p>
        <span>Ничего не опубликовано.</span>
      </div>
    </section>
  );
}

function SelectionStep({
  agentId,
  generation,
  detail,
  onBackToDrafts,
}: {
  agentId: string;
  generation: GenerationRunController;
  detail: KbGenerationRunDetail;
  onBackToDrafts: (() => void) | null;
}) {
  const { collectionLoading, collectionErrors, loadCollection } = generation;
  return (
    <section className="training-wizard__step" aria-label="Отбор">
      <h2>Отберите найденные факты</h2>
      {onBackToDrafts && <button type="button" className="btn-link" onClick={onBackToDrafts}>← К черновикам</button>}
      {detail.run.status === 'completed' && detail.run.proposalCount === 0 ? (
        <div className="knowledge-inline-state">
          <p>В переписке не нашлось новых фактов. Ничего не изменилось.</p>
          <button type="button" className="btn-sm" onClick={generation.reset}>Начать заново</button>
        </div>
      ) : (
        <ProposalWorkspace
          agentId={agentId}
          detail={detail}
          readOnly={false}
          onChanged={generation.onProposalChanged}
          onLoadAllProposals={generation.loadAllProposals}
          onLoadMoreProposals={() => void loadCollection('proposals')}
          onLoadMoreExclusions={() => void loadCollection('exclusions')}
          onLoadRawFindings={() => void loadCollection('rawFindings')}
          onLoadMoreRawFindings={() => void loadCollection('rawFindings')}
          details={<RunMetrics detail={detail} />}
          collectionState={{
            proposals: { loading: collectionLoading.includes('proposals'), error: collectionErrors.proposals, onRetry: () => void loadCollection('proposals') },
            exclusions: { loading: collectionLoading.includes('exclusions'), error: collectionErrors.exclusions, onRetry: () => void loadCollection('exclusions') },
            rawFindings: { loading: collectionLoading.includes('rawFindings'), error: collectionErrors.rawFindings, onRetry: () => void loadCollection('rawFindings') },
          }}
        />
      )}
    </section>
  );
}

function DraftStep({
  generation,
  detail,
  onPickMore,
}: {
  generation: GenerationRunController;
  detail: KbGenerationRunDetail;
  onPickMore: () => void;
}) {
  const newestOpen = detail.drafts
    .filter((draft) => draft.status === 'open')
    .reduce<KbGenerationRunDetail['drafts'][number] | null>(
      (newest, draft) => (newest === null || draft.createdAt > newest.createdAt ? draft : newest),
      null,
    );
  const loadingMore = generation.collectionLoading.includes('drafts');
  const error = generation.collectionErrors.drafts;
  return (
    <section className="training-wizard__step" aria-label="Черновик">
      <h2>Черновики разбора</h2>
      <p>Ничего не опубликовано. Откройте черновик, проверьте текст и источники.</p>
      <ol className="generation-drafts__list">
        {detail.drafts.map((draft) => (
          <li key={draft.id}>
            <Link to={`../drafts/${draft.id}`}>
              <b>{draft.title}</b>
              <span>{new Date(draft.createdAt).toLocaleDateString('ru-RU')} · {generationDraftStatusLabel(draft.status)}</span>
            </Link>
          </li>
        ))}
      </ol>
      {error && (
        <div className="knowledge-collection-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sm" onClick={() => void generation.loadCollection('drafts')}>Повторить</button>
        </div>
      )}
      {detail.draftsNextCursor !== null && (
        <button type="button" className="knowledge-load-more" disabled={loadingMore} onClick={() => void generation.loadCollection('drafts')}>
          {loadingMore ? 'Загружаем черновики…' : 'Показать ещё черновики'}
        </button>
      )}
      <div className="generation-review__actions">
        {newestOpen && <Link className="btn-accent" to={`../drafts/${newestOpen.id}`}>Открыть на проверку</Link>}
        <button type="button" className="btn" onClick={onPickMore}>Отобрать ещё</button>
      </div>
    </section>
  );
}

/** The technical numbers the main view no longer shows: batches, skips, tokens and cost. */
function RunMetrics({ detail }: { detail: KbGenerationRunDetail }) {
  const { run } = detail;
  const skipped = run.counts.skippedAiOrSystem + run.counts.skippedUnsupported + run.counts.skippedEmpty
    + run.counts.skippedSensitive + run.counts.skippedOversize + run.counts.skippedNoSeller;
  return (
    <section className="generation-review__status" aria-label="Статус разбора">
      <dl className="generation-review__metrics">
        <div><dt>Пакеты</dt><dd>{run.completedBatchCount}/{run.batchCount}</dd></div>
        <div><dt>Найдено фактов</dt><dd>{run.proposalCount}</dd></div>
        <div><dt>Пропущено</dt><dd>{skipped + run.excludedBatchCount}</dd></div>
        <div><dt>Токены / стоимость</dt><dd>{run.usage.promptTokens + run.usage.completionTokens} / ${run.usage.cost}</dd></div>
      </dl>
      <p className="generation-review__notice">Стоимость отдельных запросов может отсутствовать; точный счёт хранит AI-провайдер.</p>
    </section>
  );
}
