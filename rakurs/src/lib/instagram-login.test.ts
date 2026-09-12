import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInstagramLogin, runInstagramMessagingLogin } from './embedded-signup';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Instagram login recovery', () => {
  function sdk() {
    vi.useFakeTimers();
    let callback: (response: { authResponse?: { code?: string } }) => void = () => {};
    vi.stubGlobal('window', {
      setTimeout, clearTimeout,
      FB: { login: (cb: typeof callback) => { callback = cb; } },
    });
    return (code: string) => callback({ authResponse: { code } });
  }

  it('rejects when Meta never calls back', async () => {
    sdk();
    const result = runInstagramLogin({ appId: 'test' });
    const assertion = expect(result).rejects.toThrow('Meta не ответила');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels waiting and ignores a later code', async () => {
    const respond = sdk();
    const controller = new AbortController();
    const result = runInstagramLogin({ appId: 'test' }, controller.signal);
    const assertion = expect(result).rejects.toThrow('Вход отменён');
    await Promise.resolve();
    controller.abort();
    respond('late-code');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels while the Meta SDK is still loading', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('document', {
      createElement: () => ({}),
      head: { appendChild: () => undefined },
    });
    const controller = new AbortController();
    let rejection: unknown;
    void runInstagramLogin({ appId: 'test' }, controller.signal).catch((error) => {
      rejection = error;
    });

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    expect(rejection).toMatchObject({ message: 'Вход отменён. Закройте окно Meta.' });
  });

  it('returns the code and clears the timeout on success', async () => {
    const respond = sdk();
    const result = runInstagramLogin({ appId: 'test' });
    await Promise.resolve();
    respond('code');
    await expect(result).resolves.toBe('code');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests messaging permissions without changing the knowledge import permissions', async () => {
    vi.useFakeTimers();
    const scopes: string[] = [];
    vi.stubGlobal('window', {
      setTimeout, clearTimeout,
      FB: { login: (callback: (response: { authResponse?: { code?: string } }) => void, options: { scope: string }) => {
        scopes.push(options.scope);
        callback({ authResponse: { code: 'code' } });
      } },
    });

    await expect(runInstagramLogin({ appId: 'test' })).resolves.toBe('code');
    await expect(runInstagramMessagingLogin({ appId: 'test' })).resolves.toBe('code');

    expect(scopes).toEqual([
      'instagram_basic,pages_show_list,pages_read_engagement',
      'instagram_basic,pages_show_list,instagram_manage_messages,pages_manage_metadata',
    ]);
  });
});
