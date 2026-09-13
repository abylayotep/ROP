import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AiSandboxSessionDetail, AiSandboxSessionSummary, AiSandboxTurn } from '@rakurs/contract';

const fixture = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'member',
  data: [] as AiSandboxSessionSummary[] | undefined,
  error: undefined as unknown,
}));

vi.mock('@/store/agent', () => ({
  useAgent: () => ({ agent: { id: 'agent-1' }, role: fixture.role }),
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: fixture.data, error: fixture.error, loading: false, reload: vi.fn() }),
}));

import { TestComposer, TestScreen, TestTurnInspector, turnBubbleText } from './TestScreen';
import { initialChatState, openSession } from './test-chat';

const turn: AiSandboxTurn = {
  id: 'turn-1', revision: 1, userText: 'Есть доставка?', reply: 'Есть.',
  configVersion: 4, model: 'model-1', sourceIds: ['source-1'],
  usedItems: [{ id: 'source-1', title: 'Доставка' }], stageId: 'stage-1',
  stageName: 'Готов к покупке', fields: [{ id: 'field-1', name: 'Город', value: 'Алматы' }],
  handoff: null, outcome: 'sent', detail: 'Draft checkout only',
  effectSource: 'ai', checkout: null,
  createdAt: '2026-09-12T10:00:00.000Z',
};

const session: AiSandboxSessionDetail = {
  id: 'session-1', title: 'Проверка', phone: null, revision: 1,
  stageId: null, stageName: null, fields: [], outcome: 'sent', handoff: null,
  archivedAt: null, createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z', turns: [turn],
};

describe('testing screen', () => {
  it('keeps the isolation warning visible before any session exists', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TestScreen)));
    expect(html).toContain('Тест — сообщения не отправляются в WhatsApp');
    expect(html).toContain('Новый тест');
    expect(html).toContain('Выберите тест или создайте новый');
  });

  it('shows sources and enables correction and case saving for a selected answer', () => {
    const html = renderToStaticMarkup(createElement(TestTurnInspector, { turn, onCorrect: () => {}, onSaveCase: () => {} }));
    expect(html).toContain('Доставка');
    expect(html).toContain('Готов к покупке');
    expect(html).toContain('Алматы');
    expect(html).toMatch(/>Исправить ответ<\/button>/);
    expect(html).toMatch(/>Сохранить как тест-кейс<\/button>/);
    expect(html).not.toContain('пока недоступны');
  });

  it('labels separate CRM effects and a checkout as simulated without claiming payment creation', () => {
    const html = renderToStaticMarkup(createElement(TestTurnInspector, {
      turn: { ...turn, effectSource: 'crm', outcome: 'checkout', reply: null,
        checkout: { method: 'invoice', amount: '5000', status: 'would_create' } },
    }));
    expect(html).toContain('Отдельный CRM-разбор');
    expect(html).toContain('5000');
    expect(html).toContain('Счёт и платёж не созданы');
    expect(html).toContain('Следующие ходы не включают платёжные инструкции Kaspi');
  });

  it('shows a checkout proposal instead of saying the agent silently failed to answer', () => {
    expect(turnBubbleText({ ...turn, reply: null, outcome: 'checkout',
      checkout: { method: 'invoice', amount: '5000', status: 'would_create' } }))
      .toContain('счёт');
  });

  it('shows a retryable warning when a list reload fails with stale data', () => {
    fixture.error = new Error('Network unavailable');
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TestScreen)));
    fixture.error = undefined;
    expect(html).toContain('Не удалось обновить список тестов');
    expect(html).toContain('Повторить');
  });

  it('does not expose the owner-only workspace on a direct route for a member', () => {
    fixture.role = 'member';
    const html = renderToStaticMarkup(createElement(TestScreen));
    fixture.role = 'owner';
    expect(html).toContain('доступно только владельцу');
    expect(html).not.toContain('Новый тест');
  });

  it('renders every source id even when one display title is unavailable', () => {
    const html = renderToStaticMarkup(createElement(TestTurnInspector, {
      turn: { ...turn, sourceIds: ['source-1', 'source-missing'] },
    }));
    expect(html).toContain('Доставка');
    expect(html).toContain('source-missing');
  });

  it('describes a model failure without suggesting a WhatsApp delivery failure', () => {
    const html = renderToStaticMarkup(createElement(TestTurnInspector, {
      turn: { ...turn, outcome: 'failed' },
    }));
    expect(html).toContain('Агент не смог подготовить ответ');
    expect(html).not.toContain('Ответ не дошёл бы');
  });

  it('disables the composer and explains an archived test cannot continue', () => {
    const chat = openSession(initialChatState(), { ...session, archivedAt: '2026-09-12T11:00:00.000Z' });
    const html = renderToStaticMarkup(createElement(TestComposer, {
      chat: { ...chat, composer: 'Another question' }, onSend: () => {}, onChangeText: () => {},
    }));
    expect(html).toContain('Этот тест завершён');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Отправить/);
  });

  it('disables the composer after handoff and suggests a new test', () => {
    const chat = openSession(initialChatState(), { ...session, handoff: 'Нужен оператор' });
    const html = renderToStaticMarkup(createElement(TestComposer, {
      chat: { ...chat, composer: 'Another question' }, onSend: () => {}, onChangeText: () => {},
    }));
    expect(html).toContain('Создайте новый тест');
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});
