import { describe, expect, it } from 'vitest';
import type { CommunicationStyle, KbGenerationProposalKind, KbGenerationWarning } from '@rakurs/contract';
import { communicationStyleInstruction } from '../src/lib/ai/communication-style.js';
import { ModelError, type CompletionInput } from '../src/lib/ai/openrouter.js';
import {
  consolidateGenerationProposals,
  GenerationConsolidationError,
  planGenerationTopics,
  SEED_TOPICS,
  type ConsolidationInput,
  type RawGenerationProposal,
} from '../src/lib/knowledge/generation-consolidate.js';
import { GENERATION_LIMITS } from '../src/lib/knowledge/generation-limits.js';
import { fakeModel } from './helpers/fake-model.js';

const source = (messageId: string) => ({
  conversationId: 'conversation-1',
  messageId,
  sentAt: '2026-09-01T10:00:00.000Z',
});

const raw = (
  id: string,
  body: string,
  options: {
    kind?: KbGenerationProposalKind;
    path?: string;
    warnings?: KbGenerationWarning[];
    messageId?: string;
  } = {},
): RawGenerationProposal => ({
  id,
  kind: options.kind ?? 'knowledge',
  path: options.path ?? 'База знаний/Доставка',
  body,
  warnings: options.warnings ?? [],
  sources: [source(options.messageId ?? `message-${id}`)],
});

const input = (
  proposals: RawGenerationProposal[],
  communicationStyle: CommunicationStyle = 'warm',
  existingTopics: ConsolidationInput['existingTopics'] = [],
): ConsolidationInput => ({ proposals, communicationStyle, existingTopics });

const deps = (model: ReturnType<typeof fakeModel>) => ({
  model,
  key: 'provider-key',
  modelId: 'openai/test',
  temperature: '0.20',
});

interface AssignPayload {
  topics: string[];
  closedTopics: string[];
  proposals: { id: string; path: string; body: string }[];
}

interface WritePayload {
  topic: string;
  existingBody?: string;
  linkableTopics: string[];
  findings: { path: string; body: string; warnings: KbGenerationWarning[] }[];
}

const isAssign = (call: CompletionInput): boolean => call.maxTokens === GENERATION_LIMITS.maxAssignOutputTokens;
const payloadOf = <T>(call: CompletionInput): T => JSON.parse(call.messages[1]!.content) as T;

/**
 * Answers like the two prompts: `assign` maps each assign payload to `{id, topic}` pairs, and
 * `write` answers a topic call with a body (or a raw string / error to break it).
 */
const topicModel = (
  assign: (payload: AssignPayload, call: number) => { id: string; topic: string | null }[],
  write: (payload: WritePayload) => { body: string; confidence?: 'high' | 'review' } | string | Error =
    (payload) => ({ body: `${payload.topic}: ${payload.findings.map((finding) => finding.body).join(' ')}` }),
) => {
  const model = fakeModel();
  let assignCalls = 0;
  model.complete = async (call) => {
    model.calls.push(call);
    let text: string;
    if (isAssign(call)) {
      text = JSON.stringify({ assignments: assign(payloadOf(call), assignCalls++) });
    } else {
      const answer = write(payloadOf(call));
      if (answer instanceof Error) throw answer;
      text = typeof answer === 'string' ? answer : JSON.stringify({ confidence: 'high', ...answer });
    }
    return { text, promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
  };
  return model;
};

const allTo = (topic: string | null) => (payload: AssignPayload) =>
  payload.proposals.map((proposal) => ({ id: proposal.id, topic }));

const writeCalls = (model: ReturnType<typeof fakeModel>) => model.calls.filter((call) => !isAssign(call));

describe('generation proposal consolidation', () => {
  it('merges exact raw duplicates, keeps every message source and sums usage of both steps', async () => {
    const model = topicModel(allTo('Доставка'), () => ({ body: 'Доставка занимает два дня.' }));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Доставка занимает два дня.', { messageId: 'seller-1' }),
      raw('p2', '  доставка   занимает ДВА дня. ', { messageId: 'seller-2' }),
    ]));

    expect(model.calls).toHaveLength(2);
    expect(payloadOf<AssignPayload>(model.calls[0]!).proposals).toEqual([
      { id: 'p1', path: 'База знаний/Доставка', body: 'Доставка занимает два дня.' },
    ]);
    expect(result).toEqual({
      items: [{
        kind: 'knowledge',
        path: 'База знаний/Доставка',
        body: 'Доставка занимает два дня.',
        confidence: 'high',
        selected: true,
        sourceProposalIds: ['p1', 'p2'],
        warnings: [],
        sources: [source('seller-1'), source('seller-2')],
      }],
      usage: { promptTokens: 200, completionTokens: 40, cost: '0.00020000' },
    });
  });

  it('offers existing, chosen and seed topics and merges one topic named differently across chunks', async () => {
    const count = GENERATION_LIMITS.maxConsolidationItems + 1;
    const proposals = Array.from({ length: count }, (_, index) => raw(`p${index}`, `Условие доставки ${index}.`));
    const model = topicModel((payload, call) => allTo(call === 0 ? 'Доставка' : '  доставка ')(payload));

    const result = await consolidateGenerationProposals(deps(model), input(proposals, 'warm', [
      { path: 'База знаний/Оплата', body: 'Kaspi.' },
    ]));

    const assigns = model.calls.filter(isAssign).map((call) => payloadOf<AssignPayload>(call));
    expect(assigns).toHaveLength(2);
    expect(assigns[0]!.topics).toEqual(['Оплата', ...SEED_TOPICS.filter((seed) => seed !== 'Оплата')]);
    expect(assigns[0]!.proposals.map((proposal) => proposal.id)[0]).toBe('p1');
    expect(assigns[1]!.topics).toContain('Доставка');
    expect(assigns[1]!.topics.filter((topic) => topic.toLocaleLowerCase('ru') === 'доставка')).toHaveLength(1);
    // 41 findings pass the per-call item limit, so the one topic is written in two folded slices.
    expect(writeCalls(model).map((call) => payloadOf<WritePayload>(call).topic)).toEqual(['Доставка', 'Доставка']);
    expect(result.items).toEqual([expect.objectContaining({
      path: 'База знаний/Доставка',
      sourceProposalIds: proposals.map((proposal) => proposal.id),
    })]);
    expect(result.usage.promptTokens).toBe(400);
  });

  it('reuses an existing topic path spelling and sends its body for a full merge', async () => {
    const model = topicModel(allTo('сроки выполнения'), (payload) => ({
      body: `${payload.existingBody}\n- Срочно за день.`,
    }));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Срочно можно за день.'),
    ], 'warm', [
      { path: 'База знаний/Заказ/Сроки Выполнения', body: 'Три дня.' },
    ]));

    const write = payloadOf<WritePayload>(writeCalls(model)[0]!);
    expect(write).toMatchObject({ topic: 'Сроки Выполнения', existingBody: 'Три дня.' });
    expect(result.items).toEqual([expect.objectContaining({
      path: 'База знаний/Заказ/Сроки Выполнения',
      body: 'Три дня.\n- Срочно за день.',
    })]);
  });

  it('closes a path-only existing topic: never offered, never written, its findings dropped', async () => {
    const big = 'Б'.repeat(GENERATION_LIMITS.maxExistingTopicCharacters);
    const model = topicModel((payload) => [
      { id: 'p1', topic: 'Большая' },
      { id: 'p2', topic: 'Доставка' },
    ].filter((assignment) => payload.proposals.some((proposal) => proposal.id === assignment.id)));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Курьер звонит.'),
      raw('p2', 'Доставка два дня.'),
    ], 'warm', [
      { path: 'База знаний/Доставка', body: 'Доставка два дня.' },
      { path: 'База знаний/Большая', body: big },
    ]));

    const assign = payloadOf<AssignPayload>(model.calls[0]!);
    expect(assign.closedTopics).toEqual(['Большая']);
    expect(assign.topics).not.toContain('Большая');
    expect(writeCalls(model).map((call) => payloadOf<WritePayload>(call).topic)).toEqual(['Доставка']);
    expect(result.items.map((item) => item.path)).toEqual(['База знаний/Доставка']);
    expect(result.items[0]!.sourceProposalIds).toEqual(['p2']);
  });

  it('closes an existing topic too long to rewrite without closing the shorter ones after it', async () => {
    const long = 'Д'.repeat(GENERATION_LIMITS.maxRewritableBodyCharacters + 1);
    const model = topicModel(allTo('Оплата'));

    await consolidateGenerationProposals(deps(model), input([raw('p1', 'Оплата картой.')], 'warm', [
      { path: 'База знаний/Доставка', body: long },
      { path: 'База знаний/Оплата', body: 'Kaspi.' },
    ]));

    const assign = payloadOf<AssignPayload>(model.calls[0]!);
    expect(assign.closedTopics).toEqual(['Доставка']);
    expect(payloadOf<WritePayload>(writeCalls(model)[0]!).existingBody).toBe('Kaspi.');
  });

  it('drops null topics, missing ids, repeated ids and invented ids in the plan', async () => {
    const model = topicModel(() => [
      { id: 'p1', topic: 'Оплата' },
      { id: 'p1', topic: 'Доставка' },
      { id: 'p2', topic: null },
      { id: 'invented', topic: 'Доставка' },
    ]);

    const plan = await planGenerationTopics(deps(model), input([
      raw('a', 'Оплата Kaspi.'),
      raw('b', 'Привет, как дела?'),
      raw('c', 'Доставка два дня.'),
    ]));

    expect(model.calls).toHaveLength(1);
    expect(plan).toEqual({
      topics: [{ path: 'База знаний/Оплата', proposalIds: ['a'] }],
      droppedProposalIds: ['b', 'c'],
      usage: { promptTokens: 100, completionTokens: 20, cost: '0.00010000' },
    });
  });

  it.each([
    ['a path separator', 'Доставка/Курьер'],
    ['a phone number', 'Звоните +7 701 123 45 67'],
    ['an empty title', '   '],
  ])('drops a topic title with %s', async (_name, topic) => {
    const model = topicModel(allTo(topic));

    const result = await consolidateGenerationProposals(deps(model), input([raw('p1', 'Доставка два дня.')]));

    expect(writeCalls(model)).toHaveLength(0);
    expect(result.items).toEqual([]);
  });

  it('caps the number of topics written by one consolidation', async () => {
    const count = GENERATION_LIMITS.maxTopics + 2;
    const proposals = Array.from({ length: count }, (_, index) => raw(`p${index}`, `Факт ${index}.`));
    const model = topicModel((payload) => payload.proposals.map((proposal) => ({
      id: proposal.id, topic: `Тема ${proposal.body.replace(/\D/g, '')}`,
    })));

    const plan = await planGenerationTopics(deps(model), input(proposals));

    expect(plan.topics).toHaveLength(GENERATION_LIMITS.maxTopics);
    expect(plan.droppedProposalIds).toEqual([`p${count - 2}`, `p${count - 1}`]);
  });

  it.each([
    ['personal address', 'Адрес: улица Абая, 10'],
    ['personal introduction', 'Меня зовут Алия.'],
    ['Kazakh personal introduction', 'Менің атым Әлия.'],
    ['natural personal address', 'Меня зовут Алия, я живу на улице Абая, дом 12, квартира 4.'],
    ['Kazakh personal address', 'Менің атым Әлия, Абай көшесі 12 үй, 4 пәтерде тұрамын.'],
    ['phone number', 'Позвоните по телефону +7 701 123 45 67'],
    ['profanity', 'Это, блядь, лучший вариант'],
    ['inflected profanity in an internal command', 'Передайте сотруднику: ебаный товар надо упаковать сегодня.'],
    ['inflected profanity', 'Клиент остался недоволен хуёвым товаром.'],
    ['internal command', 'Передайте сотруднику: товар надо упаковать сегодня.'],
    ['one-off promise', 'Я лично привезу заказ сегодня вечером.'],
    ['personal name', 'Напишите Алексею'],
  ])('drops unsafe %s returned by the model', async (_name, body) => {
    const model = topicModel(allTo('Ответ'), () => ({ body }));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Безопасная подтверждённая фраза.', { kind: 'script', path: 'Скрипт/Ответ' }),
    ]));

    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it('writes legacy script findings and facts into one styled knowledge topic with ancestry and warnings', async () => {
    const body = 'Как оплатить заказ.\n\n## Факты\n- Оплата при получении.\n\n## Готовые фразы\n- «Оплатить можно при получении 😊»\n- «Тапсырысты алған кезде төлеуге болады» (қаз.)\n\nСвязано: [[Доставка]]';
    const model = topicModel(
      (payload) => payload.proposals.map((proposal) => ({
        id: proposal.id,
        topic: proposal.path.endsWith('Курьер') ? 'Доставка' : 'Оплата',
      })),
      (payload) => (payload.topic === 'Оплата' ? { body } : { body: 'Курьер звонит заранее.', confidence: 'review' }),
    );

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('knowledge-1', 'Оплата при получении.', { path: 'База знаний/Оплата' }),
      raw('script-1', 'Можно ответить про оплату при получении.', {
        kind: 'script', path: 'Скрипт/Оплата', warnings: ['context_limited'],
      }),
      raw('knowledge-2', 'Курьер звонит.', { path: 'База знаний/Курьер' }),
    ], 'friendly', [{ path: 'База знаний/Возврат', body: 'Возврат 14 дней.' }]));

    const [assign, ...writes] = model.calls;
    expect(assign!.messages[0]!.content).toContain('«Запрос города»');
    expect(assign!.messages[0]!.content).toContain('Kazakh');
    expect(assign!).not.toHaveProperty('timeoutMs');
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.maxTokens).toBe(GENERATION_LIMITS.maxTopicOutputTokens);
      expect(write.timeoutMs).toBe(GENERATION_LIMITS.topicWriteTimeoutMs);
    }
    expect(GENERATION_LIMITS.topicWriteTimeoutMs).toBe(120_000);
    const prompt = writes[0]!.messages[0]!.content;
    expect(prompt).toContain(communicationStyleInstruction('friendly'));
    expect(prompt).toContain('## Готовые фразы');
    expect(prompt).toContain('(қаз.)');
    expect(payloadOf<WritePayload>(writes[0]!)).toMatchObject({
      topic: 'Оплата',
      linkableTopics: ['Доставка', 'Возврат'],
      findings: [
        { path: 'База знаний/Оплата', body: 'Оплата при получении.', warnings: [] },
        { path: 'Скрипт/Оплата', body: 'Можно ответить про оплату при получении.', warnings: ['context_limited'] },
      ],
    });
    expect(payloadOf<WritePayload>(writes[0]!)).not.toHaveProperty('existingBody');
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'knowledge',
        path: 'База знаний/Оплата',
        body,
        confidence: 'high',
        selected: false,
        warnings: ['context_limited'],
        sourceProposalIds: ['knowledge-1', 'script-1'],
        sources: [source('message-knowledge-1'), source('message-script-1')],
      }),
      expect.objectContaining({
        path: 'База знаний/Доставка', confidence: 'review', selected: false, sourceProposalIds: ['knowledge-2'],
      }),
    ]);
  });

  it('folds a topic too large for one call slice by slice into the body written so far', async () => {
    const half = 'Д'.repeat(Math.floor(GENERATION_LIMITS.maxConsolidationCharacters / 2));
    let slice = 0;
    const model = topicModel(allTo('Доставка'), () => {
      slice += 1;
      return { body: `Тело ${slice}.`, confidence: slice === 1 ? 'review' : 'high' };
    });

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', `${half} 1`),
      raw('p2', `${half} 2`),
    ], 'warm', [{ path: 'База знаний/Доставка', body: 'Было.' }]));

    expect(model.calls.filter(isAssign)).toHaveLength(1);
    const writes = writeCalls(model).map((call) => payloadOf<WritePayload>(call));
    expect(writes.map((write) => write.existingBody)).toEqual(['Было.', 'Тело 1.']);
    expect(writes.map((write) => write.findings.length)).toEqual([1, 1]);
    expect(result.items).toEqual([expect.objectContaining({
      body: 'Тело 2.', confidence: 'review', sourceProposalIds: ['p1', 'p2'],
    })]);
  });

  it('stops folding once the written body is too long to rewrite, leaving later findings out', async () => {
    const slice = 'Д'.repeat(GENERATION_LIMITS.maxTopicSliceCharacters - 100);
    const model = topicModel(allTo('Доставка'), () => ({
      body: 'Т'.repeat(GENERATION_LIMITS.maxRewritableBodyCharacters + 1),
    }));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', `${slice} 1`),
      raw('p2', `${slice} 2`),
    ]));

    expect(writeCalls(model)).toHaveLength(1);
    expect(result.items).toEqual([expect.objectContaining({ sourceProposalIds: ['p1'] })]);
  });

  it('keeps earlier slices when a later slice comes back unsafe', async () => {
    const half = 'Д'.repeat(Math.floor(GENERATION_LIMITS.maxConsolidationCharacters / 2));
    let slice = 0;
    const model = topicModel(allTo('Доставка'), () => {
      slice += 1;
      return { body: slice === 1 ? 'Тело 1.' : 'Меня зовут Алия.' };
    });

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', `${half} 1`),
      raw('p2', `${half} 2`),
    ]));

    expect(result.items).toEqual([expect.objectContaining({ body: 'Тело 1.', sourceProposalIds: ['p1'] })]);
  });

  it.each([
    ['malformed_output', 'not json'],
    ['invalid_output', JSON.stringify({ body: '', confidence: 'high' })],
  ] as const)('fails with %s from a write call and carries the usage of every call so far', async (code, answer) => {
    const model = topicModel(allTo('Доставка'), () => answer);

    const failure = await consolidateGenerationProposals(deps(model), input([raw('p1', 'Два дня.')])).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GenerationConsolidationError);
    expect(failure).toMatchObject({ code, usage: { promptTokens: 200, completionTokens: 40, cost: '0.00020000' } });
  });

  it('fails with provider_error and keeps the usage a rejected call reported', async () => {
    const model = topicModel(allTo('Доставка'), () =>
      new ModelError('empty', 502, undefined, { promptTokens: 7, completionTokens: 0, cost: '0.00000100' }));

    const failure = await consolidateGenerationProposals(deps(model), input([raw('p1', 'Два дня.')])).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'provider_error', usage: { promptTokens: 107, completionTokens: 20, cost: '0.00010100' },
    });
  });

  it('fails with malformed_output when the assign answer does not parse', async () => {
    const model = fakeModel('{"assignments": [');

    await expect(consolidateGenerationProposals(deps(model), input([raw('p1', 'Два дня.')])))
      .rejects.toMatchObject({ code: 'malformed_output', usage: { promptTokens: 100 } });
    expect(model.calls[0]!.maxTokens).toBe(GENERATION_LIMITS.maxAssignOutputTokens);
  });

  it('chunks the assign step by item count and by previewed characters', async () => {
    const many = Array.from({ length: GENERATION_LIMITS.maxConsolidationItems + 1 }, (_, index) =>
      raw(`p${index}`, `Условие ${index}.`));
    const byCount = topicModel(allTo(null));
    await consolidateGenerationProposals(deps(byCount), input(many));
    expect(byCount.calls).toHaveLength(2);

    const long = 'Д'.repeat(Math.floor(GENERATION_LIMITS.maxConsolidationCharacters / 2));
    const previewed = topicModel(allTo(null));
    await consolidateGenerationProposals(deps(previewed), input([raw('p1', `${long} 1`), raw('p2', `${long} 2`)]));
    expect(previewed.calls).toHaveLength(1);
    expect(payloadOf<AssignPayload>(previewed.calls[0]!).proposals[0]!.body.length).toBeLessThan(400);
  });

  it('drops an exact group that cannot fit inside one bounded call', async () => {
    const model = topicModel(allTo('Доставка'));
    const oversized = raw('p1', 'Д'.repeat(GENERATION_LIMITS.maxConsolidationCharacters + 1));

    const result = await consolidateGenerationProposals(deps(model), input([oversized]));

    expect(model.calls).toHaveLength(0);
    expect(result.items).toEqual([]);
  });
});
