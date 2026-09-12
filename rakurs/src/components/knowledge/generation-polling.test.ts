import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleGenerationPolling } from './ChatGenerationPanel';

afterEach(() => {
  vi.useRealTimers();
});

describe('generation polling timer', () => {
  it('schedules another tick after every successful active poll', async () => {
    vi.useFakeTimers();
    let active = true;
    const poll = vi.fn().mockResolvedValue(undefined);
    const stop = scheduleGenerationPolling({ poll, isActive: () => active, delayMs: 1500 });

    await vi.advanceTimersByTimeAsync(1500);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(poll).toHaveBeenCalledTimes(2);
    active = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });

  it('retries after an error and stops cleanly on disposal', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const poll = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const stop = scheduleGenerationPolling({ poll, isActive: () => true, onError, delayMs: 1500 });

    await vi.advanceTimersByTimeAsync(1500);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});
