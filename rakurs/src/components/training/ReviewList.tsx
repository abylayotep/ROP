import { Link } from 'react-router-dom';
import { humanError } from '@/api';
import { Skeleton } from '@/components/ui/states';
import { draftOrigin, draftTopics, pluralRu } from '@/lib/training-state';
import type { KbDraft } from '@/types';

/**
 * «На проверке»: every open draft, whatever produced it, newest first. Opening one goes to
 * `DraftScreen`, where it is proven and applied. `drafts` is `undefined` while loading.
 */
export function ReviewList({ drafts, error, onRetry, onTeach }: {
  drafts: KbDraft[] | undefined;
  error: unknown;
  onRetry: () => void;
  onTeach: () => void;
}) {
  return (
    <div className="training-review">
      <p className="training-tab__intro">Здесь то, чему агент научился, но ещё не использует. Откройте, проверьте и нажмите «Применить» — тогда агент начнёт так отвечать.</p>
      <ReviewBody drafts={drafts} error={error} onRetry={onRetry} onTeach={onTeach} />
    </div>
  );
}

function ReviewBody({ drafts, error, onRetry, onTeach }: Parameters<typeof ReviewList>[0]) {
  if (drafts === undefined) {
    if (error !== undefined) {
      return (
        <div className="training-review__state training-review__state--error" role="alert">
          <p>Не удалось загрузить черновики.</p>
          <span>{humanError(error)}</span>
          <button type="button" className="btn-sm" onClick={onRetry}>Повторить</button>
        </div>
      );
    }
    return <Skeleton height={160} />;
  }
  if (drafts.length === 0) {
    return (
      <div className="training-review__state">
        <p>Нечего проверять</p>
        <span>Новые черновики появятся здесь, когда вы научите агента.</span>
        <button type="button" className="btn-sm" onClick={onTeach}>Научить</button>
      </div>
    );
  }
  const sorted = [...drafts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return (
    <ul className="training-review__list">
      {sorted.map((draft) => <ReviewRow key={draft.id} draft={draft} />)}
    </ul>
  );
}

/** How many first topic names a chat-generation row lists before «и ещё N». */
const TOPIC_PREVIEW = 4;

function ReviewRow({ draft }: { draft: KbDraft }) {
  const origin = draftOrigin(draft);
  // A chat-generation draft is a set of knowledge topics; counting «изменений» there says
  // nothing a seller can act on, so it names the topics instead.
  const topics = origin === 'Из переписки' ? draftTopics(draft) : null;
  const shown = topics?.names.slice(0, TOPIC_PREVIEW) ?? [];
  const rest = topics ? topics.count - shown.length : 0;
  return (
    <li className="training-review__row">
      <div className="training-review__main">
        <b className="training-review__title">{draft.title}</b>
        <span className="training-review__meta">
          <span className="training-review__origin">{origin}</span>
          <span>{topics
            ? `${topics.count} ${pluralRu(topics.count, 'тема', 'темы', 'тем')}`
            : `изменений: ${draft.ops.length}`}</span>
          <span className="mono">{new Date(draft.createdAt).toLocaleDateString('ru-RU')}</span>
        </span>
        {shown.length > 0 && (
          <span className="training-review__topics">
            {shown.join(', ')}{rest > 0 ? ` и ещё ${rest}` : ''}
          </span>
        )}
      </div>
      <Link className="btn-sm training-review__open" to={`../drafts/${draft.id}`}>Открыть</Link>
    </li>
  );
}
