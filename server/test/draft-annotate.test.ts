/**
 * The annotator: one model call per case, comparing «было», «стало» and the owner's own
 * expectation — advice in a column, never a gate. See `lib/drafts/annotate.ts`'s own comment
 * for why a failed call returns `null` instead of throwing.
 */
import { describe, expect, it } from 'vitest';
import { annotate, buildVerdictMessages, VERDICT_SCHEMA, type AnnotateDeps } from '../src/lib/drafts/annotate.js';
import { fakeModel } from './helpers/fake-model.js';

const deps = (model: ReturnType<typeof fakeModel>): AnnotateDeps => ({
  model,
  key: 'sk-or-v1-annotate-fake',
  modelId: 'anthropic/claude-sonnet-4.5',
  temperature: '0.2',
});

describe('the verdict prompt', () => {
  it('shows the expectation, the question and both answers', () => {
    const system = buildVerdictMessages({
      expectation: 'не должен обещать скидку',
      question: 'дадите скидку?',
      before: 'Дам 10%.',
      after: 'Про скидки уточню у коллеги.',
    }).map((m) => m.content).join('\n');
    expect(system).toContain('не должен обещать скидку');
    expect(system).toContain('Дам 10%.');
    expect(system).toContain('Про скидки уточню у коллеги.');
  });

  it('says there was no previous answer rather than showing an empty one', () => {
    const text = buildVerdictMessages({
      expectation: null,
      question: 'привет',
      before: null,
      after: 'Здравствуйте.',
    }).map((m) => m.content).join('\n');
    expect(text).toContain('раньше ответа не было');
  });

  it('refuses a verdict outside the three words', () => {
    expect(VERDICT_SCHEMA.safeParse({ verdict: 'отлично', reason: '' }).success).toBe(false);
  });
});

describe('annotate', () => {
  it('returns null when the model call fails, without throwing', async () => {
    const model = fakeModel(new Error('timeout'));

    await expect(
      annotate(deps(model), { expectation: null, question: 'привет', before: null, after: 'Здравствуйте.' }),
    ).resolves.toBeNull();
  });

  it('carries the cost of a reply that does not parse, rather than losing it', async () => {
    const model = fakeModel('не JSON вовсе');

    const result = await annotate(deps(model), {
      expectation: null,
      question: 'привет',
      before: null,
      after: 'Здравствуйте.',
    });

    // The model was already paid the instant it answered — a call that cannot be turned into
    // a verdict is not a call that cost nothing, and this is `null`, not `undefined`, exactly
    // so the caller can tell "no completion at all" (the previous test) apart from "a
    // completion that would not parse" without a third shape.
    expect(result).toEqual({ verdict: null, reason: null, cost: '0.00010000' });
  });

  it('returns the verdict, the reason and the cost on a good reply', async () => {
    const model = fakeModel(JSON.stringify({ verdict: 'better', reason: 'Ответ вежливее и по делу.' }));

    const result = await annotate(deps(model), {
      expectation: 'на «вы»',
      question: 'здравствуйте',
      before: 'Привет!',
      after: 'Здравствуйте!',
    });

    expect(result).toEqual({ verdict: 'better', reason: 'Ответ вежливее и по делу.', cost: '0.00010000' });
    expect(model.calls).toHaveLength(1);
  });
});
