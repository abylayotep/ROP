import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AiSandboxTurn } from '@rakurs/contract';

vi.mock('@/store/agent', () => ({
  useAgent: () => ({ agent: { id: 'agent-1' }, role: 'owner' }),
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: [], error: undefined, loading: false, reload: vi.fn() }),
}));

import { TestScreen, TestTurnInspector } from './TestScreen';

const turn: AiSandboxTurn = {
  id: 'turn-1', revision: 1, userText: 'Есть доставка?', reply: 'Есть.',
  configVersion: 4, model: 'model-1', sourceIds: ['source-1'],
  usedItems: [{ id: 'source-1', title: 'Доставка' }], stageId: 'stage-1',
  stageName: 'Готов к покупке', fields: [{ id: 'field-1', name: 'Город', value: 'Алматы' }],
  handoff: null, outcome: 'sent', detail: 'Draft checkout only',
  createdAt: '2026-09-12T10:00:00.000Z',
};

describe('testing screen', () => {
  it('keeps the isolation warning visible before any session exists', () => {
    const html = renderToStaticMarkup(createElement(TestScreen));
    expect(html).toContain('Тест — сообщения не отправляются в WhatsApp');
    expect(html).toContain('Новый тест');
    expect(html).toContain('Выберите тест или создайте новый');
  });

  it('shows sources and proposed effects without presenting future actions as live', () => {
    const html = renderToStaticMarkup(createElement(TestTurnInspector, { turn }));
    expect(html).toContain('Доставка');
    expect(html).toContain('Готов к покупке');
    expect(html).toContain('Алматы');
    expect(html).toMatch(/disabled=""[^>]*>Исправить ответ/);
    expect(html).toMatch(/disabled=""[^>]*>Сохранить как тест-кейс/);
    expect(html).toContain('пока недоступны');
  });
});
