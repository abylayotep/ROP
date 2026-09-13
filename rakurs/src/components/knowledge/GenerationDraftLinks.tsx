import { Link } from 'react-router-dom';

export function GenerationDraftLinks({ drafts }: { drafts: { id: string; title: string }[] }) {
  const categoryDraft = (title: string) => drafts.find(draft => draft.title === title || draft.title.startsWith(`${title} · `));
  const knowledge = categoryDraft('База знаний из WhatsApp');
  const script = categoryDraft('Скрипт продаж из WhatsApp');
  return <section aria-label="Результат подготовки" style={{ margin: '14px 0' }}>
    <div style={{ fontWeight: 700 }}>Результат подготовки</div>
    <p style={{ fontSize: 13 }}>Ничего не опубликовано. Откройте черновики, проверьте текст и источники.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {knowledge ? <Link className="btn" to={`../drafts/${knowledge.id}`}>Открыть базу знаний</Link>
        : <span>Новый черновик базы знаний не создан.</span>}
      {script ? <Link className="btn" to={`../drafts/${script.id}`}>Открыть скрипт</Link>
        : <span>Новый черновик скрипта не создан.</span>}
    </div>
    {(!knowledge || !script) && <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>В эту часть не попало ни одного отобранного предложения. У агента всегда один черновик базы знаний и один черновик скрипта: новые предложения добавляются в них, более новый текст заменяет старый.</p>}
  </section>;
}
