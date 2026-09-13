import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { KnowledgeTab } from '@/components/training/KnowledgeTab';
import { NextStepStrip } from '@/components/training/NextStepStrip';
import { ProductsTab } from '@/components/training/ProductsTab';
import { RepliesTab } from '@/components/training/RepliesTab';
import { ReviewList } from '@/components/training/ReviewList';
import { TeachTab } from '@/components/training/TeachTab';
import { useApi } from '@/hooks/useApi';
import {
  TRAINING_TABS,
  teachModeFromSearch,
  teachModeSearch,
  trainingSearch,
  trainingTabFromSearch,
  visibleTabs,
  type TeachMode,
  type TrainingTab,
} from '@/lib/training-routes';
import { nextStep, tabAfterKey } from '@/lib/training-state';
import { useAgent } from '@/store/agent';
import type { KbDraft, KbGenerationRunPage, KbNote } from '@/types';
import './training-workspace.css';

/**
 * «Обучение агента»: one section for what the agent knows, how it answers, how to teach it,
 * and what waits for the owner's decision. The tab lives in the URL (`lib/training-routes.ts`),
 * so deep links from dialogs, the sandbox and old bookmarks land on the right tab.
 */

export function TrainingWorkspace({
  tabs,
  activeTab,
  reviewCount,
  strip,
  onTabChange,
  children,
}: {
  tabs: TrainingTab[];
  activeTab: TrainingTab;
  reviewCount: number | null;
  strip: ReactNode;
  onTabChange: (tab: TrainingTab) => void;
  children: ReactNode;
}) {
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: TrainingTab) => {
    const next = tabAfterKey(tabs, current, event.key);
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    document.getElementById(`training-tab-${next}`)?.focus();
  };

  return (
    <article className="training-page">
      <header className="training-page__header">
        <h1>Обучение агента</h1>
        <p>Чему агент научен, как он отвечает и что ждёт вашего решения.</p>
      </header>
      {strip}
      <nav className="training-tabs" role="tablist" aria-label="Разделы обучения агента">
        {TRAINING_TABS.filter((tab) => tabs.includes(tab.id)).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`training-tab-${tab.id}`}
            aria-controls={`training-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, tab.id)}
          >
            {tab.id === 'review' && reviewCount ? `${tab.label} (${reviewCount})` : tab.label}
          </button>
        ))}
      </nav>
      <main
        className="training-page__main"
        role="tabpanel"
        id={`training-panel-${activeTab}`}
        aria-labelledby={`training-tab-${activeTab}`}
        tabIndex={0}
      >
        {children}
      </main>
    </article>
  );
}

export function TrainingScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';
  const [params, setParams] = useSearchParams();

  // Only the length matters here: an empty base opens «Научить» by default. `null` while
  // loading or failed, which `trainingTabFromSearch` treats as not empty.
  const notes = useApi<KbNote[]>((signal) => api.listKbNotes(agent.id, {}, signal), [agent.id]);
  const noteCount = notes.data ? notes.data.length : null;

  // Owner-only routes: a non-owner never asks for them.
  const drafts = useApi<KbDraft[] | null>(
    (signal) => (owner ? api.listOpenDrafts(agent.id, signal) : Promise.resolve(null)),
    [agent.id, owner],
  );
  const runs = useApi<KbGenerationRunPage | null>(
    (signal) => (owner ? api.listKnowledgeGenerationRuns(agent.id, undefined, signal) : Promise.resolve(null)),
    [agent.id, owner],
  );
  const activeRun = runs.data?.items.find((run) => run.status === 'queued' || run.status === 'running') ?? null;

  const activeTab = trainingTabFromSearch(params, { owner, noteCount });
  const teachMode = teachModeFromSearch(params);

  // Mirrors the knowledge tab's unsaved editor, so leaving the tab asks before discarding it.
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);

  const go = (tab: TrainingTab, teach?: TeachMode | null, generation?: string) => {
    if (activeTab === 'knowledge' && tab !== 'knowledge' && knowledgeDirty
      && !window.confirm('Уйти без сохранения? Несохранённые правки будут потеряны.')) return;
    if (tab !== 'knowledge') setKnowledgeDirty(false);
    const next = trainingSearch(params, tab, teach);
    if (generation !== undefined) next.set('generation', generation);
    setParams(next, { replace: true });
    // The strip and the review count go stale while the owner works in another tab.
    if (owner && tab !== activeTab) {
      drafts.reload();
      runs.reload();
    }
  };

  const step = nextStep({ owner, activeRun, openDrafts: drafts.data?.length ?? 0, noteCount });
  // A strip pointing at the view already on screen says nothing new.
  const stripShown = step !== null
    && !(step.kind === 'review' && activeTab === 'review')
    && !(step.kind !== 'review' && activeTab === 'teach' && teachMode === 'chats');

  return (
    <TrainingWorkspace
      tabs={visibleTabs(owner)}
      activeTab={activeTab}
      reviewCount={drafts.data ? drafts.data.length : null}
      strip={stripShown ? (
        <NextStepStrip
          step={step}
          onOpen={(target) => {
            if (target.kind === 'review') go('review');
            else if (target.kind === 'running') go('teach', 'chats', target.runId);
            else go('teach', 'chats');
          }}
        />
      ) : null}
      onTabChange={(tab) => go(tab)}
    >
      {activeTab === 'knowledge' && (
        <KnowledgeTab
          key={agent.id}
          onDirtyChange={setKnowledgeDirty}
          onTeach={() => go('teach', 'chats')}
          reviewCount={drafts.data?.length ?? 0}
          onOpenReview={() => go('review')}
        />
      )}

      {activeTab === 'products' && (
        <ProductsTab key={agent.id} agentId={agent.id} owner={owner} currency={agent.currency} />
      )}

      {activeTab === 'replies' && (
        <RepliesTab key={agent.id} agentId={agent.id} owner={owner} onOpenCoach={() => go('teach', 'coach')} />
      )}

      {activeTab === 'teach' && (
        <TeachTab
          key={agent.id}
          agentId={agent.id}
          mode={teachMode}
          onMode={(mode) => setParams(teachModeSearch(params, mode), { replace: true })}
          generationRunId={params.get('generation')}
          onRunId={(runId) => {
            const next = trainingSearch(params, 'teach', 'chats');
            if (runId === null) next.delete('generation');
            else next.set('generation', runId);
            setParams(next, { replace: true });
            runs.reload();
          }}
          onOpenReplies={() => go('replies')}
          onOpenRules={() => go('replies')}
          onKnowledgeChanged={notes.reload}
        />
      )}

      {activeTab === 'review' && (
        <ReviewList
          drafts={drafts.data ?? undefined}
          error={drafts.error}
          onRetry={drafts.reload}
          onTeach={() => go('teach', null)}
        />
      )}
    </TrainingWorkspace>
  );
}
