import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { CoachChat } from '@/components/coach/CoachChat';
import { ChatGenerationPanel } from '@/components/knowledge/ChatGenerationPanel';
import { KnowledgeSourceCards, recentHistorySearch } from '@/components/knowledge/KnowledgeSourceCards';
import { KnowledgeTab } from '@/components/training/KnowledgeTab';
import { RepliesTab } from '@/components/training/RepliesTab';
import { Card } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import {
  TRAINING_TABS,
  teachModeFromSearch,
  trainingSearch,
  trainingTabFromSearch,
  visibleTabs,
  type TeachMode,
  type TrainingTab,
} from '@/lib/training-routes';
import { tabAfterKey } from '@/lib/training-state';
import { useAgent } from '@/store/agent';
import type { KbDraft, KbNote } from '@/types';
import './training-workspace.css';

/**
 * «Обучение агента»: one section for what the agent knows, how it answers, how to teach it,
 * and what waits for the owner's decision. The tab lives in the URL (`lib/training-routes.ts`),
 * so deep links from dialogs, the sandbox and old bookmarks land on the right tab.
 */

const TEACH_MODE_LABELS: ReadonlyArray<{ id: TeachMode; label: string }> = [
  { id: 'chats', label: 'Из переписки WhatsApp' },
  { id: 'coach', label: 'Спросить тренера' },
  { id: 'import', label: 'Загрузить материалы' },
];

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

  // Owner-only route: a non-owner never asks for it.
  const drafts = useApi<KbDraft[] | null>(
    (signal) => (owner ? api.listOpenDrafts(agent.id, signal) : Promise.resolve(null)),
    [agent.id, owner],
  );

  const activeTab = trainingTabFromSearch(params, { owner, noteCount });
  const teachMode = teachModeFromSearch(params);

  // Mirrors the knowledge tab's unsaved editor, so leaving the tab asks before discarding it.
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);

  const go = (tab: TrainingTab, teach?: TeachMode | null) => {
    if (activeTab === 'knowledge' && tab !== 'knowledge' && knowledgeDirty
      && !window.confirm('Уйти без сохранения? Несохранённые правки будут потеряны.')) return;
    if (tab !== 'knowledge') setKnowledgeDirty(false);
    setParams(trainingSearch(params, tab, teach), { replace: true });
  };

  return (
    <TrainingWorkspace
      tabs={visibleTabs(owner)}
      activeTab={activeTab}
      reviewCount={drafts.data ? drafts.data.length : null}
      strip={null}
      onTabChange={(tab) => go(tab)}
    >
      {activeTab === 'knowledge' && (
        <KnowledgeTab key={agent.id} onDirtyChange={setKnowledgeDirty} onTeach={() => go('teach', 'chats')} />
      )}

      {activeTab === 'replies' && (
        <RepliesTab key={agent.id} agentId={agent.id} owner={owner} onOpenCoach={() => go('teach', 'coach')} />
      )}

      {activeTab === 'teach' && (
        <TeachPlaceholder
          agentId={agent.id}
          mode={teachMode}
          params={params}
          onMode={(mode) => go('teach', mode)}
          onRunId={(runId) => {
            const next = trainingSearch(params, 'teach', 'chats');
            if (runId === null) next.delete('generation');
            else next.set('generation', runId);
            setParams(next, { replace: true });
          }}
          onOpenRecentHistory={() => setParams(recentHistorySearch(params), { replace: true })}
          onKnowledgeChanged={notes.reload}
          onOpenRules={() => go('replies')}
        />
      )}

      {activeTab === 'review' && (
        <Card><EmptyState>Черновики на проверке скоро появятся здесь.</EmptyState></Card>
      )}
    </TrainingWorkspace>
  );
}

/**
 * Temporary «Научить» body: the existing generation panel, coach chat and source cards
 * behind a plain mode switch. The chooser and wizard replace it.
 */
function TeachPlaceholder({
  agentId,
  mode,
  params,
  onMode,
  onRunId,
  onOpenRecentHistory,
  onKnowledgeChanged,
  onOpenRules,
}: {
  agentId: string;
  mode: TeachMode | null;
  params: URLSearchParams;
  onMode: (mode: TeachMode | null) => void;
  onRunId: (runId: string | null) => void;
  onOpenRecentHistory: () => void;
  onKnowledgeChanged: () => void;
  onOpenRules: () => void;
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {TEACH_MODE_LABELS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={mode === item.id ? 'btn btn-sm' : 'btn-sm'}
            aria-pressed={mode === item.id}
            onClick={() => onMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {mode === null && <Card><EmptyState>Выберите способ обучения агента.</EmptyState></Card>}
      {mode === 'chats' && (
        <ChatGenerationPanel
          key={`${agentId}:chats`}
          agentId={agentId}
          initialRunId={params.get('generation')}
          mode="drafts"
          onRunId={onRunId}
          readOnly={false}
        />
      )}
      {mode === 'coach' && <CoachChat key={`${agentId}:coach`} agentId={agentId} onOpenRules={onOpenRules} />}
      {mode === 'import' && (
        <KnowledgeSourceCards
          key={`sources-${agentId}`}
          agentId={agentId}
          onChanged={onKnowledgeChanged}
          onOpenRecentHistory={onOpenRecentHistory}
        />
      )}
    </>
  );
}
