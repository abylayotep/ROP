import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ calls: 0, preview: true }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent-1' }, role: 'owner' }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: () => {}, fail: () => {} }) }));
vi.mock('@/hooks/useApi', () => ({ useApi: (fetcher: Function, deps: unknown[]) => {
  fixture.calls++;
  const call = fetcher.toString();
  const data = call.includes('listCoachMessages') ? { messages: [{ id: 'proposal-1', role: 'model', text: 'Предлагаю уточнить срок.',
    proposal: { kind: 'note', path: 'Доставка.md', body: 'Доставка занимает три дня.' },
    status: 'pending', draftId: null, conversationId: null, revision: 1, warning: null,
    sourceSnapshot: { responseText: 'Доставка завтра.', sourceRecords: [{ id: 'source-1', title: 'Проверенная доставка', content: 'Три дня.' }] },
    createdAt: '2026-09-12T10:00:00.000Z' }], rules: [] }
    : call.includes('previewResponseFeedback') ? fixture.preview ? { key: deps[1], snapshot: { responseText: 'Доставка завтра.', sourceRecords: [{ id: 'source-1', title: 'Проверенная доставка', content: 'Три дня.' }] } } : undefined
    : call.includes('getAiSandboxSession') && deps[1] === 'sandbox' ? { turns: [{ id: 'turn-1', revision: 1, userText: 'Когда доставка?', reply: 'Доставка завтра.' }] }
    : call.includes('getConversation') ? { messages: [{ id: 'message-1', aiReplyId: null, author: 'client', body: 'Когда доставка?' },
      { id: 'message-2', aiReplyId: 'reply-1', author: 'ai', body: 'Доставка завтра.' }] }
    : [];
  return { data, error: undefined, loading: false, reload: () => {} };
} }));

import { CoachChat } from './CoachChat';

function renderCorrection() {
  fixture.calls = 0;
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/a/agent-1/training?tab=teach&teach=coach&session=session-1&turn=turn-1'] },
    createElement(Routes, null, createElement(Route, { path: '/a/:agentId/training', element: createElement(CoachChat, { agentId: 'agent-1', onOpenRules: () => undefined }) }))));
}

it('shows the exact sandbox reply, verified evidence, required correction input, editable proposal and draft handoff', () => {
  const html = renderCorrection();
  expect(html).toContain('Когда доставка?');
  expect(html).toContain('Доставка завтра.');
  expect(html).toContain('Проверенная доставка: Три дня.');
  expect(html).toContain('Неверная информация');
  expect(html).toContain('Неверное поведение');
  expect(html).toContain('Как нужно исправить ответ');
  expect(html).toContain('Доставка занимает три дня.');
  expect(html).toContain('В черновик');
  expect(html).not.toContain('Применить');
});

it('does not claim source verification while preview is still loading', () => {
  fixture.preview = false;
  const html = renderCorrection();
  fixture.preview = true;
  expect(html).toContain('Проверяем источники ответа');
});

it('shows the verified live reply source before accepting an operator note', () => {
  fixture.calls = 0;
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/a/agent-1/training?tab=teach&teach=coach&conversation=dialog-1&reply=reply-1&message=message-2'] },
    createElement(Routes, null, createElement(Route, { path: '/a/:agentId/training', element: createElement(CoachChat, { agentId: 'agent-1', onOpenRules: () => undefined }) }))));
  expect(html).toContain('Клиент: Когда доставка?');
  expect(html).toContain('Агент: Доставка завтра.');
  expect(html).toContain('Проверенная доставка: Три дня.');
  expect(html).toContain('Создать предложение');
});
