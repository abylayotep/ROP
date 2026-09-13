import type { KeyboardEvent, ReactNode } from 'react';
import { tabAfterKey } from '@/lib/training-state';

export type KnowledgeTab = 'knowledge' | 'drafts' | 'runs' | 'sources';

const TABS: ReadonlyArray<{ id: KnowledgeTab; label: string }> = [
  { id: 'knowledge', label: 'Знания' },
  { id: 'drafts', label: 'Черновики' },
  { id: 'runs', label: 'Запуски' },
  { id: 'sources', label: 'Источники и загрузка' },
];

export function knowledgeTabFromSearch(params: URLSearchParams): KnowledgeTab {
  const requested = params.get('tab');
  if (TABS.some((tab) => tab.id === requested)) return requested as KnowledgeTab;
  if (params.has('generation')) return 'drafts';
  return 'knowledge';
}

export function KnowledgeWorkspace({
  activeTab,
  onTabChange,
  children,
}: {
  activeTab: KnowledgeTab;
  onTabChange: (tab: KnowledgeTab) => void;
  children: ReactNode;
}) {
  const tabIds = TABS.map((tab) => tab.id);
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: KnowledgeTab) => {
    const next = tabAfterKey(tabIds, current, event.key);
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    document.getElementById(`knowledge-tab-${next}`)?.focus();
  };

  return (
    <article className="knowledge-page">
      <header className="knowledge-page__header">
        <div>
          <p className="knowledge-page__eyebrow">Рабочее пространство</p>
          <h1>База знаний</h1>
        </div>
        <p>Проверяйте факты, формулировки и источники до публикации.</p>
      </header>
      <nav className="knowledge-tabs" role="tablist" aria-label="Разделы базы знаний">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`knowledge-tab-${tab.id}`}
            aria-controls={`knowledge-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => onTabKeyDown(event, tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <main
        className="knowledge-page__main"
        role="tabpanel"
        id={`knowledge-panel-${activeTab}`}
        aria-labelledby={`knowledge-tab-${activeTab}`}
        tabIndex={0}
      >
        {children}
      </main>
    </article>
  );
}
