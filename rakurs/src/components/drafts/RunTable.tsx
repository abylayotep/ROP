import { useState } from 'react';
import * as api from '@/api';
import { Badge } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { DraftBase, DraftOp, TestCase, TestCaseSide, TestComparison, TestRun } from '@/types';

/**
 * «Было — стало», one row per case. While `run.status === 'running'` this is watching
 * `results` fill in real time — `DraftScreen` polls the same run and hands down whatever has
 * landed so far, which is the entire reason the run answers before it is finished
 * (`server/src/api/drafts.ts`'s own file comment, "The run is asynchronous").
 */

const OUTCOME_LABEL: Record<string, string> = {
  sent: 'ушёл бы клиенту',
  unrecorded: 'дошёл бы, не записался',
  applied: 'не ответил бы, обновил карточку',
  handoff: 'передал бы человеку',
  failed: 'не дошёл бы',
  skipped: 'не стал бы отвечать',
};
const outcomeLabel = (outcome: string) => OUTCOME_LABEL[outcome] ?? outcome;
const outcomeColor = (outcome: string) =>
  outcome === 'failed' || outcome === 'unrecorded'
    ? 'var(--danger)'
    : outcome === 'handoff' || outcome === 'skipped'
      ? 'var(--warn)'
      : 'var(--text-dim)';

/** A draft op's own name: the topic's file name for a new note, the name `base` photographed
 * for an edited one. Null for rule ops, which a reply never cites. */
export function opTitle(op: DraftOp, base: DraftBase): string | null {
  if (op.op === 'note_create') return op.path.slice(op.path.lastIndexOf('/') + 1) || op.path;
  if (op.op === 'note_update') return base.noteNames?.[op.noteId] ?? 'Заметка';
  return null;
}

/**
 * The chip labels for one «стало» side. Draft notes are named through `usedOpIndexes`: their
 * chunk ids died with the replay's rollback and can never resolve. Other ids keep resolving
 * through the vault; the generic fallback is left only for rows without any op attribution.
 */
export function sectionLabels(
  side: TestCaseSide,
  ops: DraftOp[],
  base: DraftBase,
  titleOf: (id: string) => string | undefined,
): string[] {
  const fromOps = (side.usedOpIndexes ?? []).flatMap((index) => {
    const op = ops[index];
    const title = op ? opTitle(op, base) : null;
    return title === null ? [] : [title];
  });
  const fromIds = side.usedChunkIds.flatMap((id) => {
    const title = titleOf(id);
    if (title !== undefined) return [title];
    return fromOps.length === 0 ? ['новая заметка черновика'] : [];
  });
  return [...new Set([...fromOps, ...fromIds])];
}

const VERDICT: Record<'better' | 'worse' | 'same', { label: string; bg: string; fg: string }> = {
  better: { label: 'лучше', bg: 'var(--accent-a14)', fg: 'var(--accent)' },
  worse: { label: 'хуже', bg: 'var(--danger-a14)', fg: 'var(--danger)' },
  same: { label: 'так же', bg: 'var(--seg)', fg: 'var(--text-dim)' },
};

export function RunTable({
  agentId,
  cases,
  run,
  requestedCount,
  ops,
  base,
}: {
  agentId: string;
  /** For a title beside each row — a run answers by case id, never by name. */
  cases: TestCase[];
  run: TestRun | null;
  /** How many cases this run was asked to cover — known from the moment it started, before
   * `results` holds a single row, so «идёт: 3 из 12» can be said from the very first poll. */
  requestedCount: number;
  /** The draft's ops and base, to name the topics `usedOpIndexes` points at. */
  ops: DraftOp[];
  base: DraftBase;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  // `TestCaseSide.usedChunkIds` carries knowledge chunk ids, not note ids (see
  // `server/src/api/drafts.ts`'s `CaseSide`), while this map is keyed by note id — so a cited
  // chunk only gets a title here if the two ids happen to coincide. Chunks of a draft's own
  // `note_create` never outlive the rolled-back replay either; `usedOpIndexes` names those
  // instead (see `sectionLabels`).
  const notes = useApi<Map<string, string>>(
    async (signal) => new Map((await api.listKbNotes(agentId, {}, signal)).map((n) => [n.id, n.title])),
    [agentId],
  );

  if (run === null) {
    return <EmptyState>Черновик ещё не прогоняли.</EmptyState>;
  }

  // The POST that starts a run answers the instant it is admitted, before `results` has a
  // single row — `server/src/api/drafts.ts` now answers `results: []` for exactly that state,
  // matching what the `TestRun` contract promises, but this reads the field defensively rather
  // than trusting a network response's shape blindly a second time: `request<TestRun>` on the
  // client is an unchecked cast, and a guard here costs nothing.
  const results = run.results ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {run.status === 'running' && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Прогон идёт: готово {results.length} из {requestedCount}. Строки появляются по мере
          готовности.
        </div>
      )}
      {run.status === 'failed' && (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>
          Прогон не завершился до конца — часть случаев ниже может быть без результата.
        </div>
      )}

      {results.length === 0 ? (
        <EmptyState>Результатов пока нет.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            className="col-head"
            style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr 0.7fr', gap: 12, padding: '0 10px' }}
          >
            <div>Случай</div>
            <div>Было</div>
            <div>Стало</div>
            <div>Разделы</div>
            <div>Оценка</div>
          </div>

          {results.map((row) => (
            <ResultRow
              key={row.caseId}
              row={row}
              title={cases.find((c) => c.id === row.caseId)?.title ?? row.caseId}
              sections={sectionLabels(row.after, ops, base, (id) => notes.data?.get(id))}
              expanded={expanded === row.caseId}
              onToggle={() => setExpanded((cur) => (cur === row.caseId ? null : row.caseId))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SidePreview({ side }: { side: TestCaseSide | null }) {
  if (side === null) {
    return <span style={{ color: 'var(--text-dim)' }}>новый случай</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="ellipsis" style={{ display: 'block' }}>
        {side.reply ?? <span style={{ color: outcomeColor(side.outcome) }}>{outcomeLabel(side.outcome)}</span>}
      </span>
      {side.origin === 'reused' && (
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>из прошлого прогона</span>
      )}
    </div>
  );
}

function ResultRow({
  row,
  title,
  sections,
  expanded,
  onToggle,
}: {
  row: TestComparison;
  title: string;
  sections: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const verdict = row.verdict !== null ? VERDICT[row.verdict] : null;

  return (
    <div className="sunken-box" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 0,
          cursor: 'pointer',
          padding: '10px',
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr 0.7fr',
          gap: 12,
          alignItems: 'start',
          fontSize: 12,
          color: 'var(--text)',
        }}
      >
        <div className="ellipsis">{title}</div>
        <SidePreview side={row.before} />
        <SidePreview side={row.after} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {sections.length === 0 ? (
            <span style={{ color: 'var(--text-dim)' }}>—</span>
          ) : (
            sections.slice(0, 3).map((label) => (
              <span
                key={label}
                className="ellipsis"
                style={{
                  maxWidth: 110,
                  fontSize: 10.5,
                  padding: '2px 7px',
                  borderRadius: 6,
                  background: 'var(--sunken-2)',
                  border: '1px solid var(--line)',
                  color: 'var(--text-3)',
                }}
              >
                {label}
              </span>
            ))
          )}
        </div>
        <div>
          {verdict ? (
            <Badge bg={verdict.bg} fg={verdict.fg} size="row">
              {verdict.label}
            </Badge>
          ) : (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>—</span>
          )}
        </div>
      </button>

      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--line-soft)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            fontSize: 12,
          }}
        >
          {row.verdictReason && (
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>{row.verdictReason}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FullSide label="Было" side={row.before} />
            <FullSide label="Стало" side={row.after} />
          </div>
          {row.after.handoff && (
            <div style={{ color: 'var(--warn)' }}>
              Стало — передал бы человеку{row.after.handoffReason ? `: ${row.after.handoffReason}` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FullSide({ label, side }: { label: string; side: TestCaseSide | null }) {
  return (
    <div>
      <div className="eyebrow-sm" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {side === null ? (
        <div style={{ color: 'var(--text-dim)' }}>Новый случай — сравнивать не с чем.</div>
      ) : (
        <div
          className="sunken-box"
          style={{ padding: '9px 10px', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
        >
          {side.reply ?? <span style={{ color: outcomeColor(side.outcome) }}>{outcomeLabel(side.outcome)}</span>}
        </div>
      )}
    </div>
  );
}
