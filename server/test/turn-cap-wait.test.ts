/**
 * The bounded wait `takeTurnSlotWaiting` adds on top of `tryTakeTurnSlot`/`releaseTurnSlot`.
 *
 * `api/drafts.ts`'s run route used to take a slot around each `replayCase` call and *throw*
 * the instant none was free — fine for a single-call route like the sandbox or the coach, but
 * wrong for a run of many cases: a fourth run could pass its first case, spend real money
 * through case k, and then be refused outright at case k+1 for a reason that has nothing to do
 * with what it already paid for. This file proves the replacement primitive does what the fix
 * needs: it waits for a slot that frees up in time, and it still gives up rather than waiting
 * forever.
 */
import { describe, expect, it, vi } from 'vitest';
import { releaseTurnSlot, SANDBOX_TURNS, takeTurnSlotWaiting, tryTakeTurnSlot } from '../src/db/turn-cap.js';

describe('waiting for a turn-cap slot', () => {
  it('takes a free slot immediately, without waiting', async () => {
    const acquired = await takeTurnSlotWaiting(1000);
    expect(acquired).toBe(true);
    releaseTurnSlot();
  });

  it('waits for a slot that frees up before the deadline, rather than refusing', async () => {
    // Fill every slot the process has, then free exactly one shortly after — the waiter
    // should pick it up instead of being turned away the instant it finds none free.
    for (let i = 0; i < SANDBOX_TURNS; i++) expect(tryTakeTurnSlot()).toBe(true);

    const waiting = takeTurnSlotWaiting(1000);
    setTimeout(() => releaseTurnSlot(), 30);

    expect(await waiting).toBe(true);

    // The slot the waiter just took, plus every other one still held from the fill loop.
    releaseTurnSlot();
    for (let i = 0; i < SANDBOX_TURNS - 1; i++) releaseTurnSlot();
  });

  it('gives up once the bound elapses, rather than waiting forever', async () => {
    for (let i = 0; i < SANDBOX_TURNS; i++) expect(tryTakeTurnSlot()).toBe(true);

    const acquired = await takeTurnSlotWaiting(50);

    expect(acquired).toBe(false);
    for (let i = 0; i < SANDBOX_TURNS; i++) releaseTurnSlot();
  });

  // The premise the old default rested on — "whoever holds your slot can run for at most one
  // model timeout" — was never true for `api/drafts.ts`'s run route (see `turn-cap.ts`'s own
  // comment): a holder there is a whole `replayCase` call, which can run far longer than one
  // model timeout. Called with no bound at all, the wait must still be waiting long after the
  // old 60-second default would have given up — proven here with fake timers, since a real
  // five-minute sleep has no place in a unit test.
  it('waits past what the old sixty-second default ever allowed, when given no bound at all', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < SANDBOX_TURNS; i++) expect(tryTakeTurnSlot()).toBe(true);

      let settled = false;
      const waiting = takeTurnSlotWaiting().then((result) => {
        settled = true;
        return result;
      });

      // Five minutes with no slot ever freed — five times the old default bound — and the
      // wait is still going, not given up.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).toBe(false);

      releaseTurnSlot();
      await vi.advanceTimersByTimeAsync(30);

      expect(await waiting).toBe(true);
      expect(settled).toBe(true);

      // The slot the waiter just took, plus every other one still held from the fill loop.
      releaseTurnSlot();
      for (let i = 0; i < SANDBOX_TURNS - 1; i++) releaseTurnSlot();
    } finally {
      vi.useRealTimers();
    }
  });
});
