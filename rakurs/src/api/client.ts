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

/**
 * The one call that legitimately runs longer, and by how much.
 *
 * A sandbox turn waits on a model under its own sixty-second deadline on the server, so the
 * default here would abort a turn the owner has already paid for and report it as a network
 * failure. Given a margin for the round trip on top.
 */
export const LONG_TIMEOUT_MS = 70_000;

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
  /** A multipart body. Mutually exclusive with `body`, and sent without a Content-Type. */
  form?: FormData;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /** Overrides `TIMEOUT_MS` for a call the server itself is allowed to take longer over. */
  timeoutMs?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, form, query, signal, headers, timeoutMs, ...rest } = options;

  const url = new URL(`${API_URL}${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  // Свой таймаут поверх внешней отмены: экран не должен висеть, если сервер молчит.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs ?? TIMEOUT_MS);
  const abort = () => timeout.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal: timeout.signal,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        // Never set for a FormData body: the browser has to add the multipart boundary
        // itself, and a Content-Type we wrote would have none.
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : null),
        ...headers,
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  if (!res.ok) {
    // Просроченная сессия: пусть приложение покажет вход, а не каждая панель
    // по отдельности — «нет доступа».
    if (res.status === 401) window.dispatchEvent(new Event('rakurs:unauthorized'));

    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // Preserve a non-JSON error body without consuming the response twice.
    }
    throw new ApiError(`${rest.method ?? 'GET'} ${path} → ${res.status}`, res.status, payload);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
  } catch (e) {
    if (signal?.aborted || e instanceof ApiError) throw e;
    throw new ApiError(`${rest.method ?? 'GET'} ${path}: сеть недоступна`, 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
