import { Link } from 'react-router-dom';
import { humanError } from '@/api';
import { Skeleton } from '@/components/ui/states';
import { draftOrigin } from '@/lib/training-state';
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
      <p className="training-tab__intro">Изменения не видны агенту, пока вы их не примените.</p>
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
      {sorted.map((draft) => (
        <li key={draft.id} className="training-review__row">
          <div className="training-review__main">
            <b className="training-review__title">{draft.title}</b>
            <span className="training-review__meta">
              <span className="training-review__origin">{draftOrigin(draft)}</span>
              <span>изменений: {draft.ops.length}</span>
              <span className="mono">{new Date(draft.createdAt).toLocaleDateString('ru-RU')}</span>
            </span>
          </div>
          <Link className="btn-sm training-review__open" to={`../drafts/${draft.id}`}>Открыть</Link>
        </li>
      ))}
    </ul>
  );
}
