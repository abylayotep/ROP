/**
 * One send at a time per number, with a gap between them.
 *
 * Bursts are what WhatsApp bans a number for fastest, and this product produces them
 * without trying: an agent answering three customers in the same second, a stage's
 * automatic message going out to everyone who moved. The queue makes that look like a
 * person typing rather than a script firing.
 */

/** Deliberately unhurried. A reply a second later costs nothing; a banned number costs everything. */
const MIN_GAP_MS = 1200;

/** So two numbers on the same server do not fall into lockstep. */
const JITTER_MS = 400;

export interface SendQueueOptions {
  minGapMs?: number;
  jitterMs?: number;
  /** Injected by tests, which have no patience. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface SendQueue {
  <T>(numberId: string, task: () => Promise<T>): Promise<T>;
}

export function createSendQueue(options: SendQueueOptions = {}): SendQueue {
  const minGap = options.minGapMs ?? MIN_GAP_MS;
  const jitter = options.jitterMs ?? JITTER_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;

  /** The tail of each number's chain. Resolved, never rejected — see below. */
  const chains = new Map<string, Promise<unknown>>();

  return <T>(numberId: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(numberId) ?? Promise.resolve();

    // `.then(noop, noop)` rather than awaiting `previous` directly: a failed send must not
    // poison the chain behind it. Every later message on that number would otherwise be
    // rejected with the first one's error.
    const started = previous.then(
      () => undefined,
      () => undefined,
    );

    const run = started.then(async () => {
      await sleep(minGap + Math.floor(random() * jitter));
      return task();
    });

    chains.set(
      numberId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
}
