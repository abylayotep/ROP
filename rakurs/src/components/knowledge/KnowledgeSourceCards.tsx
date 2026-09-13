import { useRef, useState, type KeyboardEvent } from 'react';
import {
  HistoryImportPanelContent,
  useWhatsappHistoryState,
  whatsappHistorySummary,
} from './HistoryImportPanel';
import { ImportPanel, type ImportSourceKind } from './ImportPanel';

type SourceId = 'whatsapp' | 'instagram' | 'text' | 'page';

const SOURCES: ReadonlyArray<{
  id: SourceId;
  label: string;
  title: string;
  description: string;
  mark: string;
}> = [
  { id: 'whatsapp', label: 'WhatsApp', title: 'WhatsApp', description: 'История диалогов и сохранённые пакеты', mark: 'WA' },
  { id: 'instagram', label: 'Instagram', title: 'Instagram', description: 'Подписи к постам и описание профиля', mark: 'IG' },
  { id: 'text', label: 'Текст', title: 'Вставить текст', description: 'Прайс, условия или ответы одним текстом', mark: 'TXT' },
  { id: 'page', label: 'Веб-страница', title: 'Веб-страница', description: 'Импорт одной публичной страницы', mark: 'URL' },
];

export function sourceAfterKey<T extends string>(
  ids: readonly T[],
  current: T,
  key: string,
): T | null {
  if (ids.length === 0) return null;
  if (key === 'Home') return ids[0] ?? null;
  if (key === 'End') return ids[ids.length - 1] ?? null;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return null;
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const currentIndex = Math.max(0, ids.indexOf(current));
  return ids[(currentIndex + direction + ids.length) % ids.length] ?? null;
}

/** The shortcut starts a fresh preparation even when the URL still names an older run. */
export function recentHistorySearch(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('tab', 'teach');
  next.set('teach', 'chats');
  next.delete('generation');
  return next;
}

export function KnowledgeSourceCards({
  agentId,
  onChanged,
  onOpenRecentHistory,
  readOnly = false,
}: {
  agentId: string;
  onChanged: () => void;
  onOpenRecentHistory: () => void;
  readOnly?: boolean;
}) {
  const [active, setActive] = useState<SourceId>('text');
  const history = useWhatsappHistoryState(agentId);
  const headers = useRef<Partial<Record<SourceId, HTMLButtonElement>>>({});
  const ids = SOURCES.map((source) => source.id);

  function move(event: KeyboardEvent<HTMLButtonElement>, current: SourceId) {
    const next = sourceAfterKey(ids, current, event.key);
    if (!next) return;
    event.preventDefault();
    setActive(next);
    headers.current[next]?.focus();
  }

  return <div className="knowledge-source-cards" aria-label="Способы загрузки знаний">
    {SOURCES.map((source) => {
      const expanded = source.id === active;
      const panelId = `knowledge-source-panel-${source.id}`;
      const headerId = `knowledge-source-header-${source.id}`;
      const summaryId = `knowledge-source-summary-${source.id}`;
      const summary = source.id === 'whatsapp' ? whatsappHistorySummary(history) : source.description;
      return <article key={source.id} className={`knowledge-source-card${expanded ? ' knowledge-source-card--expanded' : ''}`} data-source-card={source.id}>
        <button
          ref={(node) => { headers.current[source.id] = node ?? undefined; }}
          id={headerId}
          type="button"
          className="knowledge-source-card__header"
          aria-label={source.label}
          aria-describedby={summaryId}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={() => setActive(source.id)}
          onKeyDown={(event) => move(event, source.id)}
        >
          <span className="knowledge-source-card__mark" aria-hidden="true">{source.mark}</span>
          <span className="knowledge-source-card__copy">
            <strong>{source.title}</strong>
            {source.id === 'whatsapp' ? (
              <span id={summaryId} className="knowledge-source-card__status">
                {summary.split(' · ').map((item) => <span key={item} className="knowledge-source-card__status-item">{item}</span>)}
              </span>
            ) : <span id={summaryId} className="knowledge-source-card__description">{summary}</span>}
          </span>
          <span className="knowledge-source-card__chevron" aria-hidden="true">⌄</span>
        </button>
        {expanded && <div id={panelId} role="region" aria-labelledby={headerId} className="knowledge-source-card__body">
          {source.id === 'whatsapp' ? <>
            {!readOnly && <div className="knowledge-source-card__shortcut">
              <div>
                <strong>Собрать знания из переписок</strong>
                <span>Откройте подготовку по всем диалогам за последние 2 недели.</span>
              </div>
              <button type="button" className="btn-sm" onClick={onOpenRecentHistory}>Открыть последние 2 недели</button>
            </div>}
            <HistoryImportPanelContent agentId={agentId} history={history} readOnly={readOnly} />
          </> : readOnly ? (
            <p className="knowledge-source-card__readonly">Загрузка источников доступна владельцу аккаунта.</p>
          ) : (
            <ImportPanel
              agentId={agentId}
              onChanged={onChanged}
              sourceKind={source.id as ImportSourceKind}
              embedded
            />
          )}
        </div>}
      </article>;
    })}
  </div>;
}
