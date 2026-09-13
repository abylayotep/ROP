import { describe, expect, it } from 'vitest';
import type { CommunicationStyle, KbGenerationProposalKind, KbGenerationWarning } from '@rakurs/contract';
import { communicationStyleInstruction } from '../src/lib/ai/communication-style.js';
import {
  consolidateGenerationProposals,
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

const answer = (items: unknown[]) => JSON.stringify({ items });

const deps = (model: ReturnType<typeof fakeModel>) => ({
  model,
  key: 'provider-key',
  modelId: 'openai/test',
  temperature: '0.20',
});

describe('generation proposal consolidation', () => {
  it('merges exact raw duplicates and keeps every immutable message source', async () => {
    const model = fakeModel(answer([{
      path: 'База знаний/Доставка',
      body: 'Доставка занимает два дня.',
      confidence: 'high',
      sourceProposalIds: ['p1'],
    }]));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Доставка занимает два дня.', { messageId: 'seller-1' }),
      raw('p2', '  доставка   занимает ДВА дня. ', { messageId: 'seller-2' }),
    ]));

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
      usage: { promptTokens: 100, completionTokens: 20, cost: '0.00010000' },
    });
  });

  it('drops model items that cite any unknown raw proposal id', async () => {
    const model = fakeModel(answer([{
      path: 'База знаний/Доставка',
      body: 'Доставка занимает два дня.',
      confidence: 'high',
      sourceProposalIds: ['p1', 'invented'],
    }]));

    expect((await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Доставка занимает два дня.'),
    ]))).items).toEqual([]);
  });

  it('semantically merges paraphrases returned by separate bounded calls', async () => {
    const proposals = Array.from({ length: GENERATION_LIMITS.maxConsolidationItems + 1 }, (_, index) =>
      raw(`p${index}`, `Подтверждённое условие ${index}.`));
    const model = fakeModel(
      answer([{
        path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', confidence: 'high', sourceProposalIds: ['p0'],
      }]),
      answer([{
        path: 'База знаний/Срок доставки', body: 'Срок доставки — двое суток.', confidence: 'high',
        sourceProposalIds: [`p${GENERATION_LIMITS.maxConsolidationItems}`],
      }]),
      answer([{
        path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', confidence: 'high',
        sourceProposalIds: ['p0', `p${GENERATION_LIMITS.maxConsolidationItems}`],
      }]),
    );

    const result = await consolidateGenerationProposals(deps(model), input(proposals));

    expect(model.calls).toHaveLength(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.sourceProposalIds).toEqual(['p0', `p${GENERATION_LIMITS.maxConsolidationItems}`]);
  });

  it('rotates a stable boundary after a merge pass does not reduce the item count', async () => {
    const proposals = Array.from({ length: GENERATION_LIMITS.maxConsolidationItems + 1 }, (_, index) =>
      raw(`p${index}`, `Подтверждённое условие ${index}.`));
    const unchanged = (ids: string[]) => answer(ids.map((id) => ({
      path: `База знаний/${id}`,
      body: `Подтверждённое условие ${id.slice(1)}.`,
      confidence: 'high',
      sourceProposalIds: [id],
    })));
    const firstIds = proposals.slice(0, GENERATION_LIMITS.maxConsolidationItems).map((proposal) => proposal.id);
    const model = fakeModel(
      unchanged(firstIds),
      unchanged(['p40']),
      unchanged(firstIds),
      unchanged(['p40']),
      answer([
        ...firstIds.slice(1, -1).map((id) => ({
          path: `База знаний/${id}`,
          body: `Подтверждённое условие ${id.slice(1)}.`,
          confidence: 'high',
          sourceProposalIds: [id],
        })),
        {
          path: 'База знаний/Граница',
          body: 'Граничное условие объединено.',
          confidence: 'high',
          sourceProposalIds: ['p39', 'p40'],
        },
      ]),
      unchanged(['p0']),
      answer([
        ...firstIds.slice(0, -1).map((id) => ({
          path: `База знаний/${id}`,
          body: `Подтверждённое условие ${id.slice(1)}.`,
          confidence: 'high',
          sourceProposalIds: [id],
        })),
        {
          path: 'База знаний/Граница',
          body: 'Граничное условие объединено.',
          confidence: 'high',
          sourceProposalIds: ['p39'],
        },
      ]),
    );

    const result = await consolidateGenerationProposals(deps(model), input(proposals));

    expect(model.calls).toHaveLength(7);
    const boundaryPass = JSON.parse(model.calls[4]!.messages[1]!.content) as {
      proposals: { exactDuplicateIds: string[] }[];
    };
    expect(boundaryPass.proposals.flatMap((proposal) => proposal.exactDuplicateIds))
      .toEqual(expect.arrayContaining(['p39', 'p40']));
    expect(result.items).toContainEqual(expect.objectContaining({
      path: 'База знаний/Граница',
      sourceProposalIds: ['p39', 'p40'],
    }));
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
    const model = fakeModel(answer([{
      path: 'База знаний/Ответ',
      body,
      confidence: 'high',
      sourceProposalIds: ['p1'],
    }]));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Безопасная подтверждённая фраза.', { kind: 'script', path: 'Скрипт/Ответ' }),
    ]));

    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it.each([
    ' База знаний/Доставка ',
    'База знаний/Доставка/',
    'База знаний//Доставка',
    'База знаний/1/2/3/4/5/6/7/8/9/10',
  ])('drops an invalid generated path: %s', async (path) => {
    const model = fakeModel(answer([{
      path,
      body: 'Доставка занимает два дня.',
      confidence: 'high',
      sourceProposalIds: ['p1'],
    }]));

    expect((await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Доставка занимает два дня.'),
    ]))).items).toEqual([]);
  });

  it('consolidates legacy script findings and facts in one styled call into knowledge topics', async () => {
    const model = fakeModel(answer([
      {
        path: 'База знаний/Оплата',
        body: 'Как оплатить заказ.\n\n## Факты\n- Оплата при получении.\n\n## Готовые фразы\n- «Оплатить можно при получении 😊»\n- «Тапсырысты алған кезде төлеуге болады» (қаз.)\n\nСвязано: [[Доставка]]',
        confidence: 'high',
        sourceProposalIds: ['knowledge-1', 'script-1'],
      },
      { path: 'Скрипт/Оплата', body: 'Оплатить можно при получении 😊', confidence: 'high', sourceProposalIds: ['script-1'] },
    ]));
    const result = await consolidateGenerationProposals(deps(model), input([
      raw('knowledge-1', 'Оплата при получении.', { path: 'База знаний/Оплата' }),
      raw('script-1', 'Можно ответить про оплату при получении.', {
        kind: 'script', path: 'Скрипт/Оплата', warnings: ['context_limited'],
      }),
    ], 'friendly'));

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.maxTokens).toBe(GENERATION_LIMITS.maxConsolidationOutputTokens);
    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).toContain(communicationStyleInstruction('friendly'));
    expect(prompt).toContain('## Готовые фразы');
    expect(prompt).toContain('[[Доставка]]');
    expect(prompt).not.toContain('"Скрипт/"');
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'knowledge',
        path: 'База знаний/Оплата',
        selected: false,
        warnings: ['context_limited'],
        sourceProposalIds: ['knowledge-1', 'script-1'],
      }),
    ]);
  });

  it('joins items that name one topic with different case after the final pass', async () => {
    const proposals = Array.from({ length: GENERATION_LIMITS.maxConsolidationItems + 1 }, (_, index) =>
      raw(`p${index}`, `Подтверждённое условие ${index}.`));
    const last = `p${GENERATION_LIMITS.maxConsolidationItems}`;
    const model = fakeModel(
      answer([{ path: 'База знаний/Доставка', body: 'Доставка два дня.', confidence: 'high', sourceProposalIds: ['p0'] }]),
      answer([{ path: 'База знаний/доставка', body: 'Курьер звонит заранее.', confidence: 'review', sourceProposalIds: [last] }]),
      answer([
        { path: 'База знаний/Доставка', body: 'Доставка два дня.', confidence: 'high', sourceProposalIds: ['p0'] },
        { path: 'База знаний/доставка', body: 'Курьер звонит заранее.', confidence: 'review', sourceProposalIds: [last] },
      ]),
    );

    const result = await consolidateGenerationProposals(deps(model), input(proposals));

    expect(result.items).toEqual([expect.objectContaining({
      path: 'База знаний/Доставка',
      body: 'Доставка два дня.\n\nКурьер звонит заранее.',
      confidence: 'review',
      selected: false,
      sourceProposalIds: ['p0', last],
    })]);
  });

  it('sends existing topics within budget, reuses their exact path, and never rewrites a path-only topic', async () => {
    const big = 'Б'.repeat(GENERATION_LIMITS.maxExistingTopicCharacters);
    const model = fakeModel(answer([
      { path: 'база знаний/доставка', body: 'Доставка два дня.\n- Курьер звонит.', confidence: 'high', sourceProposalIds: ['p1'] },
      { path: 'База знаний/Большая', body: 'Переписанная большая тема.', confidence: 'high', sourceProposalIds: ['p1'] },
    ]));

    const result = await consolidateGenerationProposals(deps(model), input([
      raw('p1', 'Курьер звонит.'),
    ], 'warm', [
      { path: 'База знаний/Доставка', body: 'Доставка два дня.' },
      { path: 'База знаний/Большая', body: big },
      { path: 'База знаний/Оплата', body: 'Kaspi.' },
    ]));

    const payload = JSON.parse(model.calls[0]!.messages[1]!.content) as { existingTopics: unknown[] };
    expect(payload.existingTopics).toEqual([
      { path: 'База знаний/Доставка', body: 'Доставка два дня.' },
      { path: 'База знаний/Большая' },
      { path: 'База знаний/Оплата' },
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({ path: 'База знаний/Доставка', body: 'Доставка два дня.\n- Курьер звонит.' }),
    ]);
  });

  it('splits same-kind inputs by configured item limits', async () => {
    const proposals = Array.from({ length: GENERATION_LIMITS.maxConsolidationItems + 1 }, (_, index) =>
      raw(`p${index}`, `Условие доставки ${index}.`));
    const model = fakeModel(answer([]));

    await consolidateGenerationProposals(deps(model), input(proposals));

    expect(model.calls).toHaveLength(2);
  });

  it('splits same-kind inputs before the configured character limit is exceeded', async () => {
    const body = 'Д'.repeat(Math.floor(GENERATION_LIMITS.maxConsolidationCharacters / 2));
    const model = fakeModel(answer([]));

    await consolidateGenerationProposals(deps(model), input([
      raw('p1', `${body} 1`),
      raw('p2', `${body} 2`),
    ]));

    expect(model.calls).toHaveLength(2);
  });

  it('drops an exact group that cannot fit inside one bounded call', async () => {
    const model = fakeModel(answer([]));
    const oversized = raw('p1', 'Д'.repeat(GENERATION_LIMITS.maxConsolidationCharacters + 1));

    const result = await consolidateGenerationProposals(deps(model), input([oversized]));

    expect(model.calls).toHaveLength(0);
    expect(result.items).toEqual([]);
  });
});
