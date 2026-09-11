import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, request } from './client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('passes an already cancelled signal to fetch and removes its listener', async () => {
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  const controller = new AbortController();
  controller.abort();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => {
    expect(options.signal?.aborted).toBe(true);
    throw new DOMException('Aborted', 'AbortError');
  });
  await expect(request('/test', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('keeps the timeout active while reading a response body', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  vi.stubGlobal('fetch', async (_url: URL, options: RequestInit) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  }));
  const result = request('/test', { timeoutMs: 100 });
  const assertion = expect(result).rejects.toBeInstanceOf(ApiError);
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves non-JSON error responses', async () => {
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  vi.stubGlobal('fetch', async () => new Response('Service unavailable', { status: 503 }));
  await expect(request('/test')).rejects.toMatchObject({ status: 503, body: 'Service unavailable' });
});
