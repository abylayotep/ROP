import type { CapiClient, CapiResult, CapiSend } from '../../src/lib/capi/client.js';

export interface FakeCapi extends CapiClient {
  /** Every call in order, so a test can assert what Meta was actually told. */
  calls: CapiSend[];
}

/**
 * A Conversions API that answers from a script.
 *
 * Pass nothing to accept everything, one entry to answer it every time, or several to answer
 * them in order — which is how a test drives the retry: a `CapiError` first, a result second.
 * An `Error` in the script is thrown instead of answered, so a refusing Meta needs no separate
 * fake, and a `CapiError` in it is what lets a test pin the difference between a refusal the
 * queue retries and one it gives up on.
 *
 * The default result reports one event received, because the common case is one event per
 * send; a test that sends two and cares about the count scripts its own.
 */
export function fakeCapi(...answers: (CapiResult | Error)[]): FakeCapi {
  const calls: CapiSend[] = [];

  return {
    calls,
    async send(input): Promise<CapiResult> {
      calls.push(input);
      // Answers run out by repeating the last one: a test that scripts one answer and drains
      // twice is testing the drain, not the length of this array.
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? {
        received: 1,
        fbtraceId: 'fbtrace-fake',
      };
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
