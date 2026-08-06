/**
 * Транспорт до бэкенда.
 *
 * Адрес задаётся VITE_API_URL; по умолчанию /api — тот же origin, что и статика,
 * так что CORS не нужен: в разработке /api проксирует dev-сервер, в продакшене
 * nginx. Никаких встроенных данных в приложении нет — всё, что видит
 * пользователь, приходит отсюда.
 */

export const API_URL = import.meta.env.VITE_API_URL || '/api';

/** Запрос дольше этого считаем зависшим — иначе экран висит в загрузке бесконечно. */
const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Текст для пользователя: без кодов и стектрейсов, но с понятной причиной. */
export function humanError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Сервер не отвечает. Проверьте соединение.';
    // Сообщение сервера точнее любого нашего: на форме входа неверный пароль
    // должен читаться как неверный пароль, а не как «войдите заново».
    if (typeof error.body === 'object' && error.body && 'message' in error.body) {
      return String((error.body as { message: unknown }).message);
    }
    if (error.status === 401 || error.status === 403) return 'Нет доступа. Войдите заново.';
    if (error.status === 404) return 'Данные не найдены.';
    if (error.status >= 500) return 'Ошибка на сервере. Попробуйте ещё раз.';
    return 'Запрос не прошёл.';
  }
  return 'Что-то пошло не так.';
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, signal, headers, ...rest } = options;

  const url = new URL(`${API_URL}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  // Свой таймаут поверх внешней отмены: экран не должен висеть, если сервер молчит.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => timeout.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal: timeout.signal,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : null),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal?.aborted) throw e;
    throw new ApiError(`${rest.method ?? 'GET'} ${path}: сеть недоступна`, 0);
  }
  clearTimeout(timer);

  if (!res.ok) {
    // Просроченная сессия: пусть приложение покажет вход, а не каждая панель
    // по отдельности — «нет доступа».
    if (res.status === 401) window.dispatchEvent(new Event('rakurs:unauthorized'));

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = await res.text().catch(() => undefined);
    }
    throw new ApiError(`${rest.method ?? 'GET'} ${path} → ${res.status}`, res.status, payload);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Период отчёта в днях — так его ждёт бэкенд. */
export const periodDays = (p: string): number => Number.parseInt(p, 10);
