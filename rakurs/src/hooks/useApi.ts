import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Загрузка данных с отменой предыдущего запроса.
 *
 * Зависимости передаются явным массивом: функция пересоздаётся на каждый рендер,
 * и если положить её в зависимости, запрос уйдёт в бесконечный цикл. При смене
 * зависимостей прошлый запрос отменяется — иначе медленный ответ на старый
 * фильтр может перезаписать свежий.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[]
): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const ref = useRef(fetcher);
  ref.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    setLoading(true);
    setError(undefined);

    ref
      .current(controller.signal)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive || controller.signal.aborted) return;
        setError(e);
        setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}

/** Значение, которое меняется не чаще, чем раз в `ms` — для поля поиска. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
