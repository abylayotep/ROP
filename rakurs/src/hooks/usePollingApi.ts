import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiState } from './useApi';

interface VisibilitySource {
  isVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

interface PollingLoop {
  refresh: () => Promise<void>;
  stop: () => void;
}

const browserVisibility: VisibilitySource = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  subscribe: (listener) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/** A single-flight timer kept separate so its lifecycle can be tested without a browser. */
export function createPollingLoop(
  run: () => Promise<void>,
  intervalMs: number,
  visibility: VisibilitySource = browserVisibility,
): PollingLoop {
  let active: Promise<void> | undefined;
  let stopped = false;

  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = run().finally(() => {
      active = undefined;
    });
    return active;
  };

  const timer = setInterval(() => {
    if (visibility.isVisible()) void refresh();
  }, intervalMs);
  const unsubscribe = visibility.subscribe(() => {
    if (visibility.isVisible()) void refresh();
  });

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}

export interface PollingApiState<T> extends ApiState<T> {
  refreshing: boolean;
}

/** Loads once, then updates in the background without replacing already rendered data. */
export function usePollingApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  intervalMs = 5_000,
): PollingApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  const loopRef = useRef<PollingLoop>();
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    let controller: AbortController | undefined;
    setData(undefined);
    setError(undefined);
    setLoading(true);
    setRefreshing(false);

    const run = async () => {
      controller = new AbortController();
      setRefreshing(true);
      try {
        const result = await fetcherRef.current(controller.signal);
        if (!alive) return;
        setData(result);
        setError(undefined);
      } catch (nextError) {
        if (!alive || controller.signal.aborted) return;
        setError(nextError);
      } finally {
        if (alive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    const loop = createPollingLoop(run, intervalMs);
    loopRef.current = loop;
    void loop.refresh();

    return () => {
      alive = false;
      loop.stop();
      controller?.abort();
      if (loopRef.current === loop) loopRef.current = undefined;
    };
    // The fetcher is intentionally held in a ref; callers pass an explicit dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);

  const reload = useCallback(() => {
    void loopRef.current?.refresh();
  }, []);

  return { data, error, loading, refreshing, reload };
}
