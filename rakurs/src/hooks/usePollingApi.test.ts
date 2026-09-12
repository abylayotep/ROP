import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPollingLoop } from './usePollingApi';

afterEach(() => {
  vi.useRealTimers();
});

describe('createPollingLoop', () => {
  it('polls every interval while the page is visible', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const visibility = fakeVisibility(true);
    const loop = createPollingLoop(run, 5_000, visibility);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('never overlaps a slow refresh with timer or manual refreshes', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const loop = createPollingLoop(run, 5_000, fakeVisibility(true));

    await vi.advanceTimersByTimeAsync(5_000);
    void loop.refresh();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(run).toHaveBeenCalledTimes(1);
    finish?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('pauses while hidden, refreshes on return, and stops permanently', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const visibility = fakeVisibility(false);
    const loop = createPollingLoop(run, 5_000, visibility);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();

    visibility.show();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    loop.stop();
    visibility.hide();
    visibility.show();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

function fakeVisibility(initiallyVisible: boolean) {
  let visible = initiallyVisible;
  let listener: (() => void) | undefined;
  return {
    isVisible: () => visible,
    subscribe: (next: () => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
    show: () => {
      visible = true;
      listener?.();
    },
    hide: () => {
      visible = false;
      listener?.();
    },
  };
}
