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
): ConsolidationInput => ({ proposals, communicationStyle });

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

  it.each([
    ['personal address', 'Адрес: улица Абая, 10'],
    ['phone number', 'Позвоните по телефону +7 701 123 45 67'],
    ['profanity', 'Это, блядь, лучший вариант'],
    ['personal name', 'Напишите Алексею'],
  ])('drops unsafe %s returned by the model', async (_name, body) => {
    const model = fakeModel(answer([{
      path: 'Скрипт/Ответ',
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

  it('applies communication style only to script calls and keeps warning-backed items unselected', async () => {
    const model = fakeModel(
      answer([{
        path: 'База знаний/Оплата', body: 'Оплата при получении.', confidence: 'high', sourceProposalIds: ['knowledge-1'],
      }]),
      answer([{
        path: 'Скрипт/Оплата', body: 'Оплатить можно при получении 😊', confidence: 'high', sourceProposalIds: ['script-1'],
      }]),
    );
    const result = await consolidateGenerationProposals(deps(model), input([
      raw('knowledge-1', 'Оплата при получении.', { path: 'База знаний/Оплата' }),
      raw('script-1', 'Можно ответить про оплату при получении.', {
        kind: 'script', path: 'Скрипт/Оплата', warnings: ['context_limited'],
      }),
    ], 'friendly'));

    const style = communicationStyleInstruction('friendly');
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]!.messages[0]!.content).not.toContain(style);
    expect(model.calls[1]!.messages[0]!.content).toContain(style);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'knowledge', selected: true, warnings: [] }),
      expect.objectContaining({ kind: 'script', selected: false, warnings: ['context_limited'] }),
    ]));
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
