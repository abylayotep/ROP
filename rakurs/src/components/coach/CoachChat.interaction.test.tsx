// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const fixture = vi.hoisted(() => ({
  previewReady: false,
  send: vi.fn(),
  status: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  draft: vi.fn(),
  draftDetail: null as any,
  cases: [] as any[],
  run: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent-1' }, role: 'owner' }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: () => {}, fail: () => {} }) }));
vi.mock('@/api', async (original) => ({
  ...(await original() as object), sendCoachMessage: fixture.send,
  getCoachFeedbackRequest: fixture.status, listCoachMessages: fixture.list,
  updateCoachProposal: fixture.update, draftCoachMessage: fixture.draft,
  runDraft: fixture.run, applyDraft: fixture.apply, getAutopilot: async () => null,
}));
vi.mock('@/hooks/useApi', () => ({ useApi: (fetcher: Function, deps: unknown[]) => {
  const call = fetcher.toString();
  const data = call.includes('getDraft(') ? fixture.draftDetail
    : call.includes('listTestCases') ? fixture.cases
    : call.includes('loadContext') ? { notes: new Map(), rules: [] }
    : call.includes('listKbNotes') ? new Map()
    : call.includes('listCoachMessages') ? { messages: [], rules: [] }
    : call.includes('previewResponseFeedback') ? fixture.previewReady
      ? { key: deps[1], snapshot: { responseText: 'Неверный ответ', sourceRecords: [{ id: 'source-1', title: 'Проверенный источник', content: 'Правильный срок' }] } }
      : undefined
    : call.includes('getAiSandboxSession') && deps[1] === 'sandbox'
      ? { turns: [{ id: 'turn-1', revision: 1, userText: 'Когда?', reply: 'Неверный ответ' }] }
    : call.includes('getConversation') ? { contactName: 'Айгуль', contactPhone: '+7', messages: [
      { id: 'message-1', aiReplyId: 'a1', author: 'ai', body: 'Неверный ответ' }] }
      : [];
  return { data, error: undefined, loading: data === undefined, reload: () => {} };
} }));

import { CoachChat } from './CoachChat';

function mount() {
  return render(<MemoryRouter initialEntries={['/a/agent-1/training?tab=teach&teach=coach&session=session-1&turn=turn-1']}>
    <Routes><Route path="/a/:agentId/training" element={<CoachChat agentId="agent-1" onOpenRules={() => {}} />} /></Routes>
  </MemoryRouter>);
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } });
  fixture.previewReady = false;
  fixture.send.mockReset();
  fixture.status.mockReset().mockResolvedValue({ status: 'pending', message: null, failureReason: null });
  fixture.list.mockReset().mockResolvedValue([]);
  fixture.update.mockReset();
  fixture.draft.mockReset().mockResolvedValue({ id: 'draft-1' });
  fixture.run.mockReset();
  fixture.apply.mockReset();
  fixture.draftDetail = null;
  fixture.cases = [];
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

it('keeps the teach tab and drops only the correction params once a live correction completes', async () => {
  fixture.previewReady = true;
  fixture.send.mockResolvedValue({ id: 'proposal-1', message: 'Предлагаю изменить заметку.',
    proposal: { kind: 'note', path: 'Доставка.md', body: 'Три дня.' }, warning: null });
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/a/agent-1/training?tab=teach&teach=coach&conversation=c1&reply=a1']}>
    <Routes><Route path="/a/:agentId/training" element={<><CoachChat agentId="agent-1" onOpenRules={() => {}} /><LocationProbe /></>} /></Routes>
  </MemoryRouter>);
  await user.type(screen.getByLabelText('Как нужно исправить ответ'), 'Ответить: три дня');
  await user.click(screen.getByRole('button', { name: 'Создать предложение' }));
  await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=teach&teach=coach'));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(fixture.send.mock.calls[0]![1]).toMatchObject({ conversationId: 'c1', aiReplyId: 'a1' });
});

it('blocks correction submit until the exact source preview has loaded, then sends one bound request', async () => {
  const user = userEvent.setup();
  const view = mount();
  await user.type(screen.getByLabelText('Как нужно исправить ответ'), 'Ответить: три дня');
  expect((screen.getByRole('button', { name: 'Создать предложение' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.send).not.toHaveBeenCalled();
  fixture.previewReady = true;
  view.rerender(<MemoryRouter initialEntries={['/a/agent-1/training?tab=teach&teach=coach&session=session-1&turn=turn-1']}>
    <Routes><Route path="/a/:agentId/training" element={<CoachChat agentId="agent-1" onOpenRules={() => {}} />} /></Routes>
  </MemoryRouter>);
  expect(screen.getByText(/Проверенный источник: Правильный срок/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Создать предложение' }));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(fixture.send.mock.calls[0]![1]).toMatchObject({ requestKey: '11111111-1111-4111-8111-111111111111',
    feedback: { source: { kind: 'sandbox_turn', sessionId: 'session-1', turnId: 'turn-1' },
      correctionType: 'fact', note: 'Ответить: три дня' } });
});

it('recovers a persisted pending key after remount without posting the same correction twice', async () => {
  fixture.previewReady = true;
  fixture.send.mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const first = mount();
  await user.type(screen.getByLabelText('Как нужно исправить ответ'), 'Ответить: три дня');
  await user.click(screen.getByRole('button', { name: 'Создать предложение' }));
  expect(fixture.send).toHaveBeenCalledTimes(1);
  expect(window.localStorage.getItem('rakurs:pending-correction:agent-1')).toContain('11111111-1111-4111-8111-111111111111');
  first.unmount();
  mount();
  await waitFor(() => expect(fixture.status).toHaveBeenCalledWith('agent-1', '11111111-1111-4111-8111-111111111111'));
  expect((screen.getByRole('button', { name: 'Создать предложение' }) as HTMLButtonElement).disabled).toBe(true);
  expect(fixture.send).toHaveBeenCalledTimes(1);
  const saved = { id: 'proposal-after-reload', role: 'model', text: 'Исправить заметку.',
    proposal: { kind: 'note', path: 'Доставка.md', body: 'Три дня.' }, warning: null,
    status: 'pending', draftId: null, conversationId: null, revision: 1, createdAt: '2026-09-12T10:00:00.000Z' };
  fixture.status.mockResolvedValue({ status: 'completed', message: saved, failureReason: null });
  fixture.list.mockResolvedValue([saved]);
  await user.click(screen.getByRole('button', { name: 'Проверить статус' }));
  await waitFor(() => expect(window.localStorage.getItem('rakurs:pending-correction:agent-1')).toBeNull());
  expect(screen.getByText('Исправить заметку.')).toBeTruthy();
  expect(fixture.send).toHaveBeenCalledTimes(1);
});

it('submits a correction, saves an edited proposal, and hands off to a draft without applying it', async () => {
  fixture.previewReady = true;
  const proposal = { kind: 'note', path: 'Доставка.md', body: 'Три дня.' };
  fixture.send.mockResolvedValue({ id: 'proposal-1', message: 'Предлагаю изменить заметку.', proposal, warning: null });
  fixture.update.mockImplementation(async (_agentId, _id, _revision, next) => ({ id: 'proposal-1', role: 'model',
    text: 'Предлагаю изменить заметку.', proposal: next, warning: null, status: 'pending', draftId: null,
    conversationId: null, revision: 2, createdAt: '2026-09-12T10:00:00.000Z' }));
  const user = userEvent.setup();
  mount();
  await user.type(screen.getByLabelText('Как нужно исправить ответ'), 'Укажите три дня');
  await user.click(screen.getByRole('button', { name: 'Создать предложение' }));
  const edit = await screen.findByDisplayValue('Три дня.');
  await user.clear(edit);
  await user.type(edit, 'Доставка за три рабочих дня.');
  expect((screen.getByRole('button', { name: 'В черновик' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Сохранить правку' }));
  await waitFor(() => expect(fixture.update).toHaveBeenCalledWith('agent-1', 'proposal-1', 1,
    { kind: 'note', path: 'Доставка.md', body: 'Доставка за три рабочих дня.' }));
  await user.click(screen.getByRole('button', { name: 'В черновик' }));
  expect(fixture.draft).toHaveBeenCalledWith('agent-1', 'proposal-1', 2);
  expect(screen.queryByRole('button', { name: 'Применить' })).toBeNull();
});

it('requires the originating regression case before enabling a separate apply action', async () => {
  const { DraftScreen } = await import('@/screens/DraftScreen');
  fixture.cases = [{ id: 'case-1', title: 'Исходный вопрос', messages: ['Когда?'], expectation: 'Три дня.',
    origin: 'correction', conversationId: null, requiredDraftId: 'draft-1', enabled: true, updatedAt: '' }];
  fixture.draftDetail = { id: 'draft-1', title: 'Исправить срок', origin: 'coach', status: 'open',
    ops: [{ op: 'note_create', path: 'Доставка.md', body: 'Три дня.' }], createdAt: '', appliedAt: null,
    runs: [], applicable: false, requiredCaseId: 'case-1' };
  fixture.run.mockResolvedValue({ id: 'run-1', status: 'running', results: [] });
  const user = userEvent.setup();
  const view = render(<MemoryRouter initialEntries={['/a/agent-1/drafts/draft-1']}>
    <Routes><Route path="/a/:agentId/drafts/:draftId" element={<DraftScreen />} /></Routes>
  </MemoryRouter>);
  expect(screen.getByText(/обязателен исходный случай/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Применить' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Запустить прогон' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Запустить прогон' }));
  expect(fixture.run).toHaveBeenCalledWith('agent-1', 'draft-1', ['case-1']);
  expect(fixture.apply).not.toHaveBeenCalled();
  view.unmount();
  fixture.draftDetail = { ...fixture.draftDetail, applicable: true };
  fixture.apply.mockResolvedValue({ ...fixture.draftDetail, status: 'applied' });
  render(<MemoryRouter initialEntries={['/a/agent-1/drafts/draft-1']}>
    <Routes><Route path="/a/:agentId/drafts/:draftId" element={<DraftScreen />} /></Routes>
  </MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Применить' }));
  expect(fixture.apply).toHaveBeenCalledWith('agent-1', 'draft-1');
});
