import { afterEach, describe, expect, it, vi } from 'vitest';
import { generationDetailErrorPresentation, scheduleGenerationPolling } from './ChatGenerationPanel';

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

  it('suppresses an in-flight error and reschedule after the active run switches', async () => {
    vi.useFakeTimers();
    let activeRunId = 'run-1';
    let rejectPoll!: (error: Error) => void;
    const onError = vi.fn();
    const poll = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPoll = reject; }));
    const stop = scheduleGenerationPolling({
      poll,
      isActive: () => activeRunId === 'run-1',
      onError,
      delayMs: 1500,
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(poll).toHaveBeenCalledTimes(1);
    activeRunId = 'run-2';
    rejectPoll(new Error('old run failed'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3000);

    expect(onError).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
    stop();
  });

  it('offers an explicit retry for terminal detail errors', () => {
    expect(generationDetailErrorPresentation('completed')).toEqual({ automatic: false, retryLabel: 'Повторить загрузку' });
    expect(generationDetailErrorPresentation('failed')).toEqual({ automatic: false, retryLabel: 'Повторить загрузку' });
    expect(generationDetailErrorPresentation('running')).toEqual({ automatic: true, retryLabel: null });
  });
});
