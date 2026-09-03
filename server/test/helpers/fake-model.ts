import type { Completion, CompletionInput, ModelClient } from '../../src/lib/ai/openrouter.js';

export interface FakeModel extends ModelClient {
  /** Every call in order, so a test can assert what the model was actually told. */
  calls: CompletionInput[];
}

/**
 * A model that answers from a script.
 *
 * Pass one string to answer it every time, or several to answer them in order — which is how
 * a test drives the retry: an unparseable answer first, a good one second. An `Error` in the
 * script is thrown instead of answered, so a failing model needs no separate fake.
 *
 * The token counts and the cost are fixed and small, so a test asserting them is asserting
 * the code that reads a `Completion` rather than a number this fake invented.
 */
export function fakeModel(...answers: (string | Error)[]): FakeModel {
  const calls: CompletionInput[] = [];

  return {
    calls,
    async complete(input): Promise<Completion> {
      calls.push(input);
      // Answers run out by repeating the last one: a test that scripts one answer and takes
      // two turns is testing the turns, not the length of this array.
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? '{}';
      if (answer instanceof Error) throw answer;
      return { text: answer, promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
    },
  };
}
