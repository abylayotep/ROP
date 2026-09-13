import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DraftOp, KbNoteDetail } from '@/types';

const notes = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: { notes, rules: [] }, error: undefined, loading: false, reload: () => undefined }),
}));

import { OPS_PAGE, OpDiff, previewBody } from './OpDiff';

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
const render = (ops: DraftOp[], topics = true, onEdit?: () => Promise<boolean>) =>
  renderToStaticMarkup(createElement(OpDiff, { agentId: 'agent-1', ops, topics, onEdit }));

describe('OpDiff', () => {
  it('explains a chat-generation draft and counts its topics', () => {
    const plain = text(render([create('Доставка'), create('Оплата')]));
    expect(plain).toContain('Темы (2)');
    expect(plain).toContain('Собрано из переписки WhatsApp');
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

  it('shows the first page of cards and offers the rest', () => {
    const plain = text(render(Array.from({ length: OPS_PAGE + 3 }, (_, index) => create(`Тема ${index}`))));
    expect(plain).toContain(`Темы (${OPS_PAGE + 3})`);
    expect(plain).toContain(`Тема ${OPS_PAGE - 1}`);
    expect(plain).not.toContain(`Тема ${OPS_PAGE} `);
    expect(plain).toContain('Показать ещё 3 из 3');
  });

  it('offers to edit and remove a topic only while the draft is editable', () => {
    expect(text(render([create('Доставка')]))).not.toContain('Убрать');
    const plain = text(render([create('Доставка')], true, async () => true));
    expect(plain).toContain('Изменить');
    expect(plain).toContain('Убрать');
    expect(plain).toContain('Лишнюю тему уберите');
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
