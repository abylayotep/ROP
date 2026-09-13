import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { KbDraft } from '@/types';

vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: undefined, error: undefined, loading: false, refreshing: false, reload: () => undefined,
}) }));
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ data: undefined, error: undefined, loading: true, reload: () => undefined }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: () => undefined, fail: () => undefined }) }));

import { NextStepStrip } from './NextStepStrip';
import { ReviewList } from './ReviewList';
import { TeachTab } from './TeachTab';

const render = (element: ReactElement) => renderToStaticMarkup(
  createElement(MemoryRouter, { future: { v7_startTransition: true, v7_relativeSplatPath: true } }, element),
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const teach = (mode: 'chats' | 'coach' | 'import' | null) => createElement(TeachTab, {
  agentId: 'agent-1',
  mode,
  onMode: () => undefined,
  generationRunId: null,
  onRunId: () => undefined,
  onOpenReplies: () => undefined,
  onOpenRules: () => undefined,
  onKnowledgeChanged: () => undefined,
});

const draft = (id: string, origin: KbDraft['origin'], title: string, createdAt: string, ops: number | KbDraft['ops']): KbDraft => ({
  id, origin, title, createdAt, status: 'open', appliedAt: null, base: {},
  ops: typeof ops === 'number' ? Array.from({ length: ops }, (_, index) => ({ op: 'note_create', path: `n${index}`, body: 'b' })) : ops,
});
const topic = (name: string) => ({ op: 'note_create' as const, path: `База знаний/${name}`, body: '## Факты\n- …' });

describe('TeachTab', () => {
  it('offers three ways to teach the agent', () => {
    const html = text(render(teach(null)));
    expect(html).toContain('Из переписки WhatsApp');
    expect(html).toContain('Агент сам соберёт темы базы знаний — факты и готовые фразы — из ваших ответов клиентам');
    expect(html).toContain('Спросить тренера');
    expect(html).toContain('Опишите, как отвечать, или исправьте конкретный ответ агента');
    expect(html).toContain('Загрузить материалы');
    expect(html).toContain('Текст, страница сайта, Instagram или старая история WhatsApp');
    expect(html.match(/Выбрать/g)).toHaveLength(3);
    expect(html).not.toContain('← Все способы');
  });

  it('shows the chosen mode under a way back to the chooser', () => {
    const html = text(render(teach('import')));
    expect(html).toContain('← Все способы');
    expect(html).toContain('WhatsApp');
    expect(html).toContain('Instagram');
    expect(html).not.toContain('Выбрать');
  });
});

describe('ReviewList', () => {
  const drafts = [
    draft('d-old', 'coach', 'Правило про доставку', '2026-09-10T10:00:00Z', 1),
    draft('d-new', 'manual', 'Правка цен', '2026-09-12T10:00:00Z', 4),
  ];

  it('lists open drafts newest first with their origin and a way to open them', () => {
    const html = render(createElement(ReviewList, { drafts, error: undefined, onRetry: () => undefined, onTeach: () => undefined }));
    const plain = text(html);
    expect(plain).toContain('Здесь то, чему агент научился, но ещё не использует');
    expect(plain).toContain('нажмите «Применить» — тогда агент начнёт так отвечать');
    expect(plain.indexOf('Правка цен')).toBeLessThan(plain.indexOf('Правило про доставку'));
    expect(plain.indexOf('Вручную')).toBeLessThan(plain.indexOf('Тренер'));
    expect(plain).toContain('изменений: 4');
    expect(plain).toContain('изменений: 1');
    expect(html.match(/>Открыть</g)).toHaveLength(2);
    expect(html).toContain('href="/drafts/d-new"');
    expect(plain).not.toContain('Нечего проверять');
  });

  it('names the topics of a chat-generation draft instead of counting changes', () => {
    const ops = [
      topic('Доставка'), topic('Цены и размеры'), topic('Оплата'),
      { op: 'note_update' as const, noteId: 'note-1', body: 'b' },
      topic('Сроки'), topic('Приветствие'),
    ];
    const plain = text(render(createElement(ReviewList, {
      drafts: [draft('d-wa', 'manual', 'Обучение из переписки', '2026-09-12T10:00:00Z', ops)],
      error: undefined, onRetry: () => undefined, onTeach: () => undefined,
    })));
    expect(plain).toContain('Из переписки');
    expect(plain).toContain('6 тем');
    expect(plain).toContain('Доставка, Цены и размеры, Оплата, Сроки и ещё 2');
    expect(plain).not.toContain('изменений');
    expect(plain).not.toContain('База знаний/');
  });

  it('lists every topic without a tail when there are few', () => {
    const plain = text(render(createElement(ReviewList, {
      drafts: [draft('d-wa', 'manual', 'База знаний из WhatsApp · 2', '2026-09-12T10:00:00Z', [topic('Доставка'), topic('Оплата')])],
      error: undefined, onRetry: () => undefined, onTeach: () => undefined,
    })));
    expect(plain).toContain('2 темы');
    expect(plain).toContain('Доставка, Оплата');
    expect(plain).not.toContain('и ещё');
  });

  it('says there is nothing to review and offers teaching', () => {
    const plain = text(render(createElement(ReviewList, { drafts: [], error: undefined, onRetry: () => undefined, onTeach: () => undefined })));
    expect(plain).toContain('Нечего проверять');
    expect(plain).toContain('Научить');
  });

  it('shows a load failure with a retry, never the empty state', () => {
    const html = render(createElement(ReviewList, { drafts: undefined, error: new Error('boom'), onRetry: () => undefined, onTeach: () => undefined }));
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Повторить');
    expect(text(html)).not.toContain('Нечего проверять');
  });
});

describe('NextStepStrip', () => {
  const strip = (step: Parameters<typeof NextStepStrip>[0]['step']) =>
    text(render(createElement(NextStepStrip, { step, onOpen: () => undefined })));

  it('names the one next action', () => {
    expect(strip({ kind: 'running', percent: 33, runId: 'r1' })).toContain('Идёт разбор переписки — 33%');
    expect(strip({ kind: 'review', count: 3 })).toContain('3 черновика ждут проверки');
    expect(strip({ kind: 'review', count: 1 })).toContain('1 черновик ждёт проверки');
    expect(strip({ kind: 'empty' })).toContain('База пустая. Начните с переписки WhatsApp');
    expect(strip({ kind: 'empty' })).toContain('Открыть');
  });

  it('renders nothing without a next step', () => {
    expect(render(createElement(NextStepStrip, { step: null, onOpen: () => undefined }))).toBe('');
  });
});
