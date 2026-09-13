import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { KbGraph } from '@/types';

vi.mock('@/store/app-state', () => ({ useAppState: () => ({ theme: 'light' }) }));

import { Graph } from './Graph';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const note = (id: string) => ({ id, title: id, path: `База знаний/${id}` });
const render = (graph: KbGraph, onOpenReview?: () => void) =>
  renderToStaticMarkup(createElement(Graph, { graph, onOpenNote: () => undefined, onOpenReview }));

describe('Graph', () => {
  it('points an empty base at the review tab when drafts wait', () => {
    const empty = { notes: [], links: [], truncated: false };
    expect(text(render(empty, () => undefined))).toContain('Граф появится, когда в базе знаний будут заметки.');
    expect(text(render(empty, () => undefined))).toContain('Открыть «На проверке»');
    expect(text(render(empty))).not.toContain('Открыть «На проверке»');
  });

  it('explains where links come from when notes have none', () => {
    const plain = text(render({ notes: [note('Доставка'), note('Оплата')], links: [], truncated: false }));
    expect(plain).toContain('Связей пока нет: они появляются из ссылок [[Название]] в тексте заметок.');
  });

  it('shows no hint once notes link each other', () => {
    const plain = text(render({ notes: [note('Доставка'), note('Оплата')], links: [{ from: 'Доставка', to: 'Оплата' }], truncated: false }));
    expect(plain).not.toContain('Связей пока нет');
  });
});
