// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutopilotStatus, AutopilotStep, DraftAutopilot } from '@/types';
import { AutopilotPanel, autopilotHeadline } from './AutopilotPanel';

const autopilot = (patch: Partial<DraftAutopilot> = {}): DraftAutopilot => ({
  id: 'auto-1',
  status: 'running',
  step: 'prepare_cases',
  runsStarted: 0,
  maxRuns: 4,
  runId: null,
  caseIds: [],
  log: [],
  cost: '0',
  stopReason: null,
  createdAt: '2026-09-14T10:00:00.000Z',
  finishedAt: null,
  ...patch,
});

afterEach(cleanup);

describe('autopilotHeadline', () => {
  const cases: [AutopilotStatus, AutopilotStep, Partial<DraftAutopilot>, string][] = [
    ['running', 'prepare_cases', {}, 'Идёт: подбираем проверки'],
    ['running', 'clean_topics', {}, 'Идёт: чистим темы'],
    ['running', 'start_run', { runsStarted: 0 }, 'Идёт: прогон 1 из 4'],
    ['running', 'await_run', { runsStarted: 2 }, 'Идёт: прогон 2 из 4'],
    ['running', 'fix_topics', {}, 'Идёт: исправляем темы'],
    ['running', 'apply', {}, 'Идёт: применяем'],
    ['applied', 'apply', {}, 'Проверено и применено'],
    ['stopped', 'await_run', { stopReason: 'Прогоны закончились' }, 'Остановлено: Прогоны закончились'],
    ['cancelled', 'start_run', {}, 'Проверка остановлена'],
  ];
  it.each(cases)('%s at %s', (status, step, patch, expected) => {
    expect(autopilotHeadline(autopilot({ status, step, ...patch }))).toBe(expected);
  });
});

describe('AutopilotPanel', () => {
  it('shows the log newest first and the spend in dollars', () => {
    render(<AutopilotPanel
      autopilot={autopilot({
        cost: '0.0123',
        log: [
          { at: '2026-09-14T10:00:00.000Z', kind: 'info', text: 'Подобрали 5 проверок' },
          { at: '2026-09-14T10:01:00.000Z', kind: 'fix', text: 'Переписали тему «Доставка»' },
        ],
      })}
      onCancel={() => undefined}
      cancelling={false}
    />);
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Переписали тему «Доставка»', 'Подобрали 5 проверок']);
    expect(screen.getByText('Потрачено: 0,0123 $')).toBeTruthy();
    expect(screen.getByText('Автопроверка')).toBeTruthy();
  });

  it('offers «Остановить» while running and calls onCancel', async () => {
    const onCancel = vi.fn();
    render(<AutopilotPanel autopilot={autopilot()} onCancel={onCancel} cancelling={false} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Остановить' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables «Остановить» while the cancel is in flight', () => {
    render(<AutopilotPanel autopilot={autopilot()} onCancel={() => undefined} cancelling />);
    expect((screen.getByRole('button', { name: 'Остановить' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each<AutopilotStatus>(['applied', 'stopped', 'cancelled'])('hides «Остановить» once %s', (status) => {
    render(<AutopilotPanel autopilot={autopilot({ status })} onCancel={() => undefined} cancelling={false} />);
    expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull();
  });
});
