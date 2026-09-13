import { Link } from 'react-router-dom';
import { isWhatsAppDraftTitle, LEGACY_WHATSAPP_DRAFT_TITLES, WHATSAPP_DRAFT_TITLE } from '@/lib/training-state';

/** Chat generation keeps one draft, «Обучение из переписки». An agent whose old per-kind
 * drafts have not been regrouped yet still gets a link to one of those instead. */
export function GenerationDraftLinks({ drafts }: { drafts: { id: string; title: string }[] }) {
  const draft = [WHATSAPP_DRAFT_TITLE, ...LEGACY_WHATSAPP_DRAFT_TITLES]
    .map((title) => drafts.find((item) => isWhatsAppDraftTitle(item.title, title)))
    .find((item) => item !== undefined);
  return <section aria-label="Результат подготовки" style={{ margin: '14px 0' }}>
    <div style={{ fontWeight: 700 }}>Результат подготовки</div>
    <p style={{ fontSize: 13 }}>Ничего не опубликовано. Откройте черновик, проверьте темы и источники.</p>
    {draft ? <Link className="btn" to={`../drafts/${draft.id}`}>Открыть черновик</Link>
      : <span>Черновик не создан: не выбрано ни одной темы.</span>}
    <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>Все отобранные темы собираются в один черновик. Новая версия темы заменяет старую.</p>
  </section>;
}
