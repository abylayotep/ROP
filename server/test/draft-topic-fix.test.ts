import { describe, expect, it } from 'vitest';
import {
  cleanTopic,
  inventedNumbers,
  rewriteTopic,
  TOPIC_FIX_INPUT_MAX,
  TopicFixError,
} from '../src/lib/drafts/topic-fix.js';

const fakeModel = (text: string) =>
  ({ complete: async () => ({ text, cost: '0.001', promptTokens: 0, completionTokens: 0 }) }) as never;
const deps = (text: string) => ({ model: fakeModel(text), key: 'k', modelId: 'm', temperature: '0.2' });

describe('inventedNumbers', () => {
  it('lists digit runs absent from the original', () => {
    expect(inventedNumbers('Задаток 3000 тг, +77066241022', 'Задаток 3000 тг, доставка 1000')).toEqual(['1000']);
  });
  it('accepts reformatted but identical numbers', () => {
    expect(inventedNumbers('цена 9 990 тг', 'цена 9990 тг')).toEqual([]);
  });
});

describe('cleanTopic', () => {
  it('returns the cleaned body and reason', async () => {
    const out = await cleanTopic(
      deps('{"body":"## Факты\\n- Задаток 3000 тг","reason":"Убраны реплики из переписки"}'),
      { title: 'Оплата', body: '## Факты\n- Задаток 3000 тг\n- Тапсырыс бересіз бе?🤗' },
    );
    expect(out.body).toBe('## Факты\n- Задаток 3000 тг');
    expect(out.reason).toBe('Убраны реплики из переписки');
    expect(out.cost).toBe('0.001');
  });
  it('rejects an invented price', async () => {
    await expect(
      cleanTopic(deps('{"body":"Задаток 5000 тг","reason":"x"}'), { title: 't', body: 'Задаток 3000 тг' }),
    ).rejects.toMatchObject({ code: 'invented_number' });
  });
  it('rejects malformed output and keeps its cost', async () => {
    const attempt = cleanTopic(deps('not json'), { title: 't', body: 'b' });
    await expect(attempt).rejects.toBeInstanceOf(TopicFixError);
    await expect(attempt).rejects.toMatchObject({ code: 'malformed_output', cost: '0.001' });
  });
  it('rejects an empty body', async () => {
    await expect(cleanTopic(deps('{"body":"  ","reason":"x"}'), { title: 't', body: 'b' })).rejects.toMatchObject({
      code: 'empty',
    });
  });
  it('refuses an oversized topic without calling the model', async () => {
    let called = false;
    const model = {
      complete: async () => {
        called = true;
        return { text: '{}', cost: '1', promptTokens: 0, completionTokens: 0 };
      },
    } as never;
    await expect(
      cleanTopic({ model, key: 'k', modelId: 'm', temperature: '0.2' }, { title: 't', body: 'x'.repeat(TOPIC_FIX_INPUT_MAX + 1) }),
    ).rejects.toMatchObject({ code: 'too_long', cost: '0' });
    expect(called).toBe(false);
  });
  it('returns the original body with an empty reason when nothing changed', async () => {
    const out = await cleanTopic(deps('{"body":"Задаток 3000 тг\\n","reason":"ничего"}'), {
      title: 't',
      body: 'Задаток 3000 тг',
    });
    expect(out).toEqual({ body: 'Задаток 3000 тг', reason: '', cost: '0.001' });
  });
});

describe('rewriteTopic', () => {
  it('sends the failing case to the model', async () => {
    let seen = '';
    const model = {
      complete: async (i: { messages: { content: string }[] }) => {
        seen = JSON.stringify(i.messages);
        return {
          text: '{"body":"Оформление: размер, дизайн, задаток 3000","reason":"Убрана реплика"}',
          cost: '0',
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    } as never;
    await rewriteTopic(
      { model, key: 'k', modelId: 'm', temperature: '0.2' },
      {
        title: 'Оформление заказа',
        body: 'Тапсырыс бересіз бе? задаток 3000',
        cases: [
          {
            title: 'Запрос на оформление',
            messages: ['Хочу заказать'],
            before: 'Уточню',
            after: 'Тапсырыс бересіз бе?',
            reason: 'Нет информации',
          },
        ],
      },
    );
    expect(seen).toContain('Хочу заказать');
    expect(seen).toContain('Нет информации');
  });
});
