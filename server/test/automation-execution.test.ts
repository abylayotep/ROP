import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  releaseTurnSlot,
  SANDBOX_TURNS,
  tryTakeTurnSlot,
} from '../src/db/turn-cap.js';
import {
  type AutomationTransaction,
  withAgentAutomationLock,
} from '../src/lib/automation/execution.js';

interface Gate {
  wait: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function controlledDb() {
  let transactionStarts = 0;
  const tx = {
    execute: async () => [],
  } as unknown as AutomationTransaction;
  const db = {
    transaction: async <T>(effect: (transaction: AutomationTransaction) => Promise<T>) => {
      transactionStarts += 1;
      return effect(tx);
    },
  } as unknown as Db;
  return { db, transactionStarts: () => transactionStarts };
}

function expectEveryPermitAvailable(): void {
  let acquired = 0;
  try {
    while (tryTakeTurnSlot()) acquired += 1;
    expect(acquired).toBe(SANDBOX_TURNS);
  } finally {
    for (let index = 0; index < acquired; index += 1) releaseTurnSlot();
    // Restore permits leaked by the implementation under test so a RED run cannot poison
    // the next test in this process.
    for (let index = acquired; index < SANDBOX_TURNS; index += 1) releaseTurnSlot();
  }
}

describe('automation lock admission', () => {
  it('keeps an additional lock user outside a transaction until a permit is released', async () => {
    const controlled = controlledDb();
    const blockers = Array.from({ length: SANDBOX_TURNS }, gate);
    const running: Promise<unknown>[] = blockers.map((blocker) =>
      withAgentAutomationLock(controlled.db, 'agent-1', async () => blocker.wait),
    );

    try {
      await vi.waitFor(() => {
        expect(controlled.transactionStarts()).toBe(SANDBOX_TURNS);
      });

      const additional = withAgentAutomationLock(controlled.db, 'agent-1', async () => undefined);
      running.push(additional);
      await new Promise((resolve) => setImmediate(resolve));

      expect(controlled.transactionStarts()).toBe(SANDBOX_TURNS);

      blockers[0]!.release();
      await vi.waitFor(() => {
        expect(controlled.transactionStarts()).toBe(SANDBOX_TURNS + 1);
      });
    } finally {
      for (const blocker of blockers) blocker.release();
      await Promise.allSettled(running);
    }
  });

  it('releases its permit when the locked effect throws and the transaction rolls back', async () => {
    const controlled = controlledDb();

    await expect(
      withAgentAutomationLock(controlled.db, 'agent-1', async () => {
        throw new Error('Provider timed out');
      }),
    ).rejects.toThrow('Provider timed out');

    expectEveryPermitAvailable();
  });

  it('releases its permit when the transaction rejects before the effect starts', async () => {
    const rejectedDb = {
      transaction: async () => {
        throw new Error('Transaction rejected');
      },
    } as unknown as Db;

    await expect(
      withAgentAutomationLock(rejectedDb, 'agent-1', async () => undefined),
    ).rejects.toThrow('Transaction rejected');

    expectEveryPermitAvailable();
  });
});
