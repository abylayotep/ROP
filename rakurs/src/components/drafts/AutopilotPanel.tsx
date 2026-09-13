import { money } from '@/components/drafts/cost';
import { Card, CardHead } from '@/components/ui/primitives';
import type { DraftAutopilot } from '@/types';

const KIND_COLOR: Record<DraftAutopilot['log'][number]['kind'], string | undefined> = {
  info: undefined,
  fix: 'var(--accent)',
  remove: 'var(--danger)',
  warn: 'var(--text-dim)',
};

/** One line saying where the autopilot is; the log below says what it did. */
export function autopilotHeadline(a: DraftAutopilot): string {
  if (a.status === 'applied') return 'Проверено и применено';
  if (a.status === 'stopped') return `Остановлено: ${a.stopReason}`;
  if (a.status === 'cancelled') return 'Проверка остановлена';
  switch (a.step) {
    case 'prepare_cases':
      return 'Идёт: подбираем проверки';
    case 'clean_topics':
      return 'Идёт: чистим темы';
    case 'start_run':
    case 'await_run':
      // Before the first run is admitted `runsStarted` is still 0, yet the run being prepared is
      // the first one.
      return `Идёт: прогон ${Math.max(a.runsStarted, 1)} из ${a.maxRuns}`;
    case 'fix_topics':
      return 'Идёт: исправляем темы';
    case 'apply':
      return 'Идёт: применяем';
  }
}

export function AutopilotPanel({
  autopilot,
  onCancel,
  cancelling,
}: {
  autopilot: DraftAutopilot;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const running = autopilot.status === 'running';
  // The server appends; the owner wants the latest step on top.
  const log = [...autopilot.log].reverse();

  return (
    <Card className="draft-autopilot">
      <CardHead
        title="Автопроверка"
        right={running && (
          <button type="button" className="btn" disabled={cancelling} onClick={onCancel}>
            Остановить
          </button>
        )}
      />
      <p className="draft-autopilot__headline" role="status">{autopilotHeadline(autopilot)}</p>
      {log.length > 0 && (
        <ul className="draft-autopilot__log">
          {log.map((entry, index) => (
            <li key={`${entry.at}-${index}`} style={{ color: KIND_COLOR[entry.kind] }}>{entry.text}</li>
          ))}
        </ul>
      )}
      <p className="draft-autopilot__cost">Потрачено: {money(autopilot.cost)}</p>
    </Card>
  );
}
