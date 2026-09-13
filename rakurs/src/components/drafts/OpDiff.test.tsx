import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DraftOp, KbNoteDetail } from '@/types';

const notes = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: { notes, rules: [] }, error: undefined, loading: false, reload: () => undefined }),
}));

import { OpDiff, previewBody } from './OpDiff';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const topicBody = [
  'Как и когда доставляем заказы.',
  '',
  '## Факты',
  '- По городу доставка за 1 день.',
  '- В регионы 3–5 дней.',
  '',
  '## Готовые фразы',
  '- «Доставим завтра»',
  '- «Ертең жеткіземіз» (қаз.)',
  '',
  'Связано: [[Оплата]]',
].join('\n');
const create = (name: string): DraftOp => ({ op: 'note_create', path: `База знаний/${name}`, body: topicBody });
const render = (ops: DraftOp[], topics = true) => renderToStaticMarkup(createElement(OpDiff, { agentId: 'agent-1', ops, topics }));

describe('OpDiff', () => {
  it('explains a chat-generation draft and counts its topics', () => {
    const plain = text(render([create('Доставка'), create('Оплата')]));
    expect(plain).toContain('Темы (2)');
    expect(plain).toContain('Собрано из переписки WhatsApp');
    expect(plain).toContain('После применения темы появятся во вкладке «Знания»');
    expect(plain).not.toContain('Изменение');
  });

  it('keeps the plain heading for other drafts', () => {
    const plain = text(render([create('Доставка')], false));
    expect(plain).toContain('Изменение');
    expect(plain).not.toContain('Собрано из переписки');
  });

  it('renders a new topic as readable markdown under its name, not as an added-lines diff', () => {
    const html = render([create('Доставка')]);
    const plain = text(html);
    expect(html).toMatch(/class="draft-topic__title">Доставка</);
    expect(html).toMatch(/class="draft-topic__folder">База знаний</);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<h2[^>]*>Факты<\/h2>/);
    expect(html).toContain('<li>«Ертең жеткіземіз» (қаз.)</li>');
    expect(plain).toContain('Оплата');
    expect(html).not.toContain('[[Оплата]]');
    expect(html).not.toContain('+ ');
  });

  it('collapses cards to their first lines when a draft has more than five ops', () => {
    const html = render(Array.from({ length: 6 }, (_, index) => create(`Тема ${index}`)));
    expect(html).not.toContain('aria-expanded="true"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(6);
    expect(html).toContain('Как и когда доставляем заказы.');
    expect(html).not.toContain('В регионы 3–5 дней.');
    expect(html).toContain('Показать всё');
  });

  it('keeps a line diff for an update under the same header', () => {
    notes.set('note-1', { id: 'note-1', path: 'База знаний/Оплата', body: 'Старый текст' } as KbNoteDetail);
    const html = render([{ op: 'note_update', noteId: 'note-1', body: 'Новый текст' }]);
    expect(html).toMatch(/class="draft-topic__title">Оплата</);
    expect(html).toContain('Правка');
    expect(html).toContain('− Старый текст');
    expect(html).toContain('+ Новый текст');
  });
});

describe('previewBody', () => {
  it('keeps the first non-blank lines', () => {
    expect(previewBody('a\n\nb\n\nc\nd')).toBe('a\nb\nc');
  });
});
