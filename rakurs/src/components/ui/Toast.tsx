import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { humanError } from '@/api';

/**
 * Короткие сообщения о результате действий. Нужны там, где действие меняет
 * данные на сервере: если сохранить не удалось, пользователь должен об этом
 * узнать, а не гадать, почему тумблер вернулся обратно.
 */

type ToastKind = 'ok' | 'error';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  ok: (text: string) => void;
  fail: (error: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      ok: (text) => push('ok', text),
      fail: (error, fallback) => push('error', fallback ?? humanError(error)),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          maxWidth: 380,
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '11px 14px',
              borderRadius: 11,
              background: 'var(--card)',
              border: `1px solid ${
                t.kind === 'error' ? 'rgba(216,87,76,0.4)' : 'rgba(13,150,104,0.35)'
              }`,
              fontSize: 12.5,
              lineHeight: 1.45,
              color: 'var(--text-2)',
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                marginTop: 1,
                fontWeight: 700,
                color: t.kind === 'error' ? 'var(--danger)' : 'var(--accent)',
              }}
            >
              {t.kind === 'error' ? '✕' : '✓'}
            </span>
            <span className="pretty">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast вызван вне ToastProvider');
  return ctx;
}
