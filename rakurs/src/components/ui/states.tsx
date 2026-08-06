import type { CSSProperties, ReactNode } from 'react';
import { humanError } from '@/api';

/* Состояния загрузки, ошибки и пустого результата — одинаковые на всех экранах. */

/** Прямоугольник-заглушка на месте будущего содержимого. */
export function Skeleton({
  height = 16,
  width = '100%',
  radius = 6,
  style,
}: {
  height?: number | string;
  width?: number | string;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ height, width, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}

/** Карточка-заглушка под KPI: столько же строк и та же высота, что у настоящей. */
export function KpiSkeleton() {
  return (
    <div className="card" style={{ padding: '16px 17px' }}>
      <Skeleton height={11} width="55%" />
      <Skeleton height={27} width="70%" style={{ marginTop: 10 }} />
      <Skeleton height={11} width="85%" style={{ marginTop: 12 }} />
    </div>
  );
}

/** Заглушка под строки таблицы. */
export function RowsSkeleton({ rows = 5, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            padding: '13px 18px',
            borderBottom: '1px solid var(--line-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            height,
          }}
        >
          <Skeleton height={12} width="22%" />
          <Skeleton height={12} width="30%" />
          <Skeleton height={12} width="18%" />
          <Skeleton height={12} width="12%" />
        </div>
      ))}
    </div>
  );
}

/**
 * Ошибка загрузки. Всегда с кнопкой повтора: сеть отваливается чаще, чем ломается
 * бэкенд, и перезагружать всю страницу ради одного блока не нужно.
 */
export function ErrorState({
  error,
  onRetry,
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: compact ? '20px 16px' : '40px 20px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>
        {humanError(error)}
      </div>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '32px 16px',
        textAlign: 'center',
        fontSize: 12.5,
        color: 'var(--text-dim)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Обёртка над состоянием запроса: показывает заглушку, ошибку с повтором или
 * содержимое. Данные попадают в children уже гарантированно определёнными.
 */
export function Async<T>({
  state,
  skeleton,
  children,
  compactError = false,
}: {
  state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void };
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
  compactError?: boolean;
}) {
  if (state.error !== undefined && state.data === undefined) {
    return <ErrorState error={state.error} onRetry={state.reload} compact={compactError} />;
  }
  if (state.data === undefined) return <>{skeleton}</>;
  return <>{children(state.data)}</>;
}
