// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { DraftAutopilot } from '@/types';

const fixture = vi.hoisted(() => ({
  draftDetail: null as any,
  cases: [] as any[],
  getAutopilot: vi.fn(),
  startAutopilot: vi.fn(),
  getDraft: vi.fn(),
  getDraftRun: vi.fn(),
  ok: vi.fn(),
  fail: vi.fn(),
}));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent-1' }, role: 'owner' }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: fixture.ok, fail: fixture.fail }) }));
vi.mock('@/api', async (original) => ({
  ...(await original() as object),
  getAutopilot: fixture.getAutopilot,
  startAutopilot: fixture.startAutopilot,
  getDraft: fixture.getDraft,
  getDraftRun: fixture.getDraftRun,
}));
vi.mock('@/hooks/useApi', () => ({ useApi: (fetcher: Function) => {
  const call = fetcher.toString();
  const data = call.includes('getDraft(') ? fixture.draftDetail
    : call.includes('listTestCases') ? fixture.cases
    : call.includes('loadContext') ? { notes: new Map(), rules: [] }
    : call.includes('listKbNotes') ? new Map()
    : [];
  return { data, error: undefined, loading: false, reload: () => {} };
} }));

import { ApiError } from '@/api/client';
import { DraftScreen } from './DraftScreen';

const autopilot = (patch: Partial<DraftAutopilot> = {}): DraftAutopilot => ({
  id: 'auto-1', status: 'running', step: 'prepare_cases', runsStarted: 0, maxRuns: 4, runId: null,
  caseIds: [], log: [], cost: '0', stopReason: null, createdAt: '', finishedAt: null, ...patch,
});

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function mount() {
  return render(<MemoryRouter initialEntries={['/a/agent-1/drafts/draft-1']}>
    <Routes>
      <Route path="/a/:agentId/drafts/:draftId" element={<DraftScreen />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>);
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
/** One autopilot poll interval, with the awaited reads it starts. */
const nextPoll = () => act(() => vi.advanceTimersByTimeAsync(3000));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fixture.cases = [{ id: 'case-1', title: 'Доставка', messages: ['Когда?'], expectation: null,
    origin: 'manual', conversationId: null, requiredDraftId: null, enabled: true, updatedAt: '' }];
  fixture.draftDetail = { id: 'draft-1', title: 'Темы', origin: 'coach', status: 'open',
    ops: [{ op: 'note_create', path: 'База знаний/Доставка', body: 'Три дня.' }], base: {},
    createdAt: '', appliedAt: null, runs: [], applicable: false, requiredCaseId: null };
  fixture.getDraft.mockResolvedValue(fixture.draftDetail);
  fixture.getDraftRun.mockResolvedValue({ id: 'run-1', status: 'running', results: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('starts the autopilot with the ticked cases and locks the manual controls while it runs', async () => {
  fixture.getAutopilot.mockResolvedValue(null);
  fixture.startAutopilot.mockResolvedValue(autopilot({ caseIds: ['case-1'] }));
  mount();
  await waitFor(() => expect(button('Запустить прогон').disabled).toBe(false));
  await user().click(button('Проверить и применить'));

  expect(fixture.startAutopilot).toHaveBeenCalledWith('agent-1', 'draft-1', ['case-1']);
  await waitFor(() => expect(screen.getByText('Идёт: подбираем проверки')).toBeTruthy());
  expect(button('Проверяем…').disabled).toBe(true);
  expect(button('Запустить прогон').disabled).toBe(true);
  expect(button('Применить').disabled).toBe(true);
  expect(button('Отбросить').disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Убрать' })).toBeNull();
});

it('sends no ids when nothing is ticked and names the autopilot in the hint', async () => {
  fixture.cases = [];
  fixture.getAutopilot.mockResolvedValue(null);
  fixture.startAutopilot.mockResolvedValue(autopilot());
  mount();
  expect(screen.getByText(/Нажмите «Проверить и применить» — проверки подберутся сами/)).toBeTruthy();
  await user().click(button('Проверить и применить'));
  expect(fixture.startAutopilot).toHaveBeenCalledWith('agent-1', 'draft-1', []);
});

it('follows the autopilot run and leaves for review once it applies', async () => {
  fixture.getAutopilot
    .mockResolvedValueOnce(autopilot({ step: 'await_run', runsStarted: 1, runId: 'run-1', caseIds: ['case-1'] }))
    .mockResolvedValue(autopilot({ status: 'applied', step: 'apply', runsStarted: 1, runId: 'run-1', caseIds: ['case-1'] }));
  mount();
  await waitFor(() => expect(screen.getByText('Идёт: прогон 1 из 4')).toBeTruthy());
  await nextPoll();
  await nextPoll();
  await waitFor(() => expect(screen.getByTestId('where').textContent).toMatch(/\/training$/));
  expect(fixture.getDraftRun).toHaveBeenCalledWith('agent-1', 'draft-1', 'run-1');
  expect(fixture.ok).toHaveBeenCalledWith('Черновик проверен и применён');
});

it('keeps polling through a failed read and toasts the outage once', async () => {
  fixture.getAutopilot
    .mockResolvedValueOnce(autopilot())
    .mockRejectedValueOnce(new ApiError('down', 0))
    .mockRejectedValueOnce(new ApiError('down', 0))
    .mockResolvedValue(autopilot({ status: 'applied', step: 'apply' }));
  mount();
  await waitFor(() => expect(screen.getByText('Идёт: подбираем проверки')).toBeTruthy());
  await nextPoll();
  await nextPoll();
  expect(fixture.fail).toHaveBeenCalledTimes(1);
  await nextPoll();
  await waitFor(() => expect(screen.getByTestId('where').textContent).toMatch(/\/training$/));
  expect(fixture.fail).toHaveBeenCalledTimes(1);
  expect(fixture.ok).toHaveBeenCalledWith('Черновик проверен и применён');
});

it('shows no run and no error when the followed run was deleted', async () => {
  fixture.getAutopilot.mockResolvedValue(autopilot({ step: 'await_run', runsStarted: 1, runId: 'run-9' }));
  fixture.getDraftRun.mockRejectedValue(new ApiError('gone', 404));
  mount();
  await waitFor(() => expect(screen.getByText('Идёт: прогон 1 из 4')).toBeTruthy());
  await nextPoll();
  await nextPoll();
  expect(fixture.getDraftRun).toHaveBeenCalledTimes(1);
  expect(fixture.fail).not.toHaveBeenCalled();
  expect(screen.getByText('Черновик ещё не прогоняли.')).toBeTruthy();
});

it('retries a followed run whose read failed for another reason', async () => {
  fixture.getAutopilot.mockResolvedValue(autopilot({ step: 'await_run', runsStarted: 1, runId: 'run-9' }));
  fixture.getDraftRun.mockRejectedValueOnce(new ApiError('down', 0));
  mount();
  await waitFor(() => expect(screen.getByText('Идёт: прогон 1 из 4')).toBeTruthy());
  await nextPoll();
  await nextPoll();
  expect(fixture.getDraftRun).toHaveBeenCalledTimes(2);
});
