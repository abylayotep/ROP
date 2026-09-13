import { CoachChat } from '@/components/coach/CoachChat';
import { KnowledgeSourceCards } from '@/components/knowledge/KnowledgeSourceCards';
import type { TeachMode } from '@/lib/training-routes';
import { GenerationWizard } from './GenerationWizard';

const WAYS: ReadonlyArray<{ id: TeachMode; title: string; text: string }> = [
  { id: 'chats', title: 'Из переписки WhatsApp', text: 'Агент сам соберёт факты и скрипт из ваших ответов клиентам' },
  { id: 'coach', title: 'Спросить тренера', text: 'Опишите, как отвечать, или исправьте конкретный ответ агента' },
  { id: 'import', title: 'Загрузить материалы', text: 'Текст, страница сайта, Instagram или старая история WhatsApp' },
];

/**
 * «Научить»: a chooser of three ways to teach the agent; the chosen one fills the tab under a
 * link back to the chooser. The mode lives in the URL (`?teach=`), so deep links skip the chooser.
 */
export function TeachTab({
  agentId,
  mode,
  onMode,
  generationRunId,
  onRunId,
  onOpenReplies,
  onOpenRules,
  onKnowledgeChanged,
}: {
  agentId: string;
  mode: TeachMode | null;
  onMode: (mode: TeachMode | null) => void;
  generationRunId: string | null;
  onRunId: (id: string | null) => void;
  onOpenReplies: () => void;
  onOpenRules: () => void;
  onKnowledgeChanged: () => void;
}) {
  if (mode === null) {
    return (
      <div className="training-teach">
        <p className="training-tab__intro">Выберите, как научить агента. Всё найденное сначала попадёт в черновик на проверку.</p>
        <ul className="training-chooser">
          {WAYS.map((way) => (
            <li key={way.id} className="training-chooser__card">
              <h2 className="training-chooser__title">{way.title}</h2>
              <p className="training-chooser__text">{way.text}</p>
              <button type="button" className="btn training-chooser__pick" onClick={() => onMode(way.id)}>Выбрать</button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="training-teach">
      <button type="button" className="btn-link training-teach__back" onClick={() => onMode(null)}>← Все способы</button>
      {mode === 'chats' && (
        <GenerationWizard
          key={`${agentId}:chats`}
          agentId={agentId}
          initialRunId={generationRunId}
          onRunId={onRunId}
          onOpenReplies={onOpenReplies}
        />
      )}
      {mode === 'coach' && <CoachChat key={`${agentId}:coach`} agentId={agentId} onOpenRules={onOpenRules} />}
      {mode === 'import' && (
        <KnowledgeSourceCards
          key={`${agentId}:import`}
          agentId={agentId}
          onChanged={onKnowledgeChanged}
          onOpenRecentHistory={() => onMode('chats')}
        />
      )}
    </div>
  );
}
