import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Route, Routes } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Board } from '@/types';

const fixture = vi.hoisted(() => ({ data: undefined as Board | undefined }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' } }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ fail: vi.fn() }) }));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ data: fixture.data, loading: false, error: undefined, reload: vi.fn() }) }));
import { BoardScreen, matchesBoardSearch } from './BoardScreen';

const card = { conversationId: 'lead-1', contactName: 'Анна', contactPhone: '+77012345678', preview: 'Нужна доставка', lastMessageAt: '2026-09-12T10:00:00Z', paidTotal: '0.00', windowOpen: true, adHeadline: null, assigneeName: null };
const render = () => renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/funnel' }, createElement(Routes, null, createElement(Route, { path: '/a/:agentId' }, createElement(Route, { path: 'funnel', element: createElement(BoardScreen) })))));

describe('funnel cards', () => {
  it('searches contacts and message context without case sensitivity', () => {
    expect(matchesBoardSearch(card, ' АННА ')).toBe(true);
    expect(matchesBoardSearch(card, '123456')).toBe(true);
    expect(matchesBoardSearch(card, 'ДОСТАВКА')).toBe(true);
    expect(matchesBoardSearch(card, 'другой')).toBe(false);
  });
  it('keeps a keyboard-accessible conversation link and stage selector', () => {
    fixture.data = { currency: 'KZT', unsorted: [card], columns: [] };
    const html = render();
    expect(html).toContain('Требуют разбора');
    expect(html).toContain('href="/a/agent/dialogs?conversation=lead-1"');
    expect(html).toContain('aria-label="Этап сделки Анна"');
    expect(html).not.toContain('0 ₸');
    expect(html).not.toContain('Добавить заказ');
  });
  it('hides the unsorted column when it has no cards', () => {
    fixture.data = { currency: 'KZT', unsorted: [], columns: [] };
    expect(render()).not.toContain('Требуют разбора');
  });
});
