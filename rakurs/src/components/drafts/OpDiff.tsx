import { useMemo, type ReactNode } from 'react';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { ruleCategoryLabel } from '@/lib/rule-categories';
import type { AgentRule, DraftOp, KbNoteDetail } from '@/types';

/**
 * The change a draft would make — read before a single case is run, because the table below
 * answers «стало отвечать лучше», not «стало значить то, что владелец думает».
 *
 * A note op gets a line-by-line diff of its body: that is the whole content of a note, and
 * the owner reads it the same way they would read it in the editor. A rule op does not — a
 * rule is one sentence, and a diff of one sentence against itself is noise; it shows the
 * category and the text the rule would read, which is what `agent-coaching.md` already says a
 * rule *is*.
 */

type NoteUpdateOp = Extract<DraftOp, { op: 'note_update' }>;
type RuleUpdateOp = Extract<DraftOp, { op: 'rule_update' }>;
const isNoteUpdate = (op: DraftOp): op is NoteUpdateOp => op.op === 'note_update';
const isRuleUpdate = (op: DraftOp): op is RuleUpdateOp => op.op === 'rule_update';

interface OpContext {
  notes: Map<string, KbNoteDetail>;
  rules: AgentRule[];
}

async function loadContext(agentId: string, ops: DraftOp[], signal: AbortSignal): Promise<OpContext> {
  const noteIds = [...new Set(ops.filter(isNoteUpdate).map((op) => op.noteId))];
  const needsRules = ops.some(isRuleUpdate);

  const [noteRows, rules] = await Promise.all([
    Promise.all(noteIds.map((id) => api.getKbNote(agentId, id, signal))),
    needsRules ? api.listRules(agentId, signal) : Promise.resolve([]),
  ]);

  return { notes: new Map(noteRows.map((row) => [row.id, row])), rules };
}

export function OpDiff({ agentId, ops }: { agentId: string; ops: DraftOp[] }) {
  // `ops` is the draft's own array, read fresh only when the draft itself reloads — a stable
  // reference the rest of the time, so this does not refetch on every render.
  const ctx = useApi<OpContext>((signal) => loadContext(agentId, ops, signal), [agentId, ops]);

  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 12 }}>Изменение</div>
      <Async state={ctx} skeleton={<Skeleton height={120} />}>
        {(loaded) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {ops.map((op, i) => (
              <OpCard key={i} op={op} ctx={loaded} />
            ))}
          </div>
        )}
      </Async>
    </Card>
  );
}

function OpCard({ op, ctx }: { op: DraftOp; ctx: OpContext }) {
  switch (op.op) {
    case 'note_create':
      return (
        <div>
          <OpTitle>Новая заметка «{op.path}»</OpTitle>
          <NoteDiff oldBody="" newBody={op.body} />
        </div>
      );

    case 'note_update': {
      // `loadContext` fetched exactly this id — a note gone since would have thrown there and
      // surfaced through the outer `Async`'s own error state, not reached this branch at all.
      const note = ctx.notes.get(op.noteId)!;
      return (
        <div>
          <OpTitle>Правка заметки «{note.path}»</OpTitle>
          <NoteDiff oldBody={note.body} newBody={op.body} />
        </div>
      );
    }

    case 'rule_create':
      return (
        <div>
          <OpTitle>Новое правило: {ruleCategoryLabel(op.category)}</OpTitle>
          <RuleText category={op.category} text={op.text} />
        </div>
      );

    case 'rule_update': {
      const rule = ctx.rules.find((r) => r.id === op.ruleId);
      const category = rule?.category ?? null;
      const text = op.text ?? rule?.text ?? '';
      const named = rule ? ` «${rule.text}»` : '';
      const action = op.enabled === false ? 'Выключить правило' : op.enabled === true ? 'Включить правило' : 'Правка правила';
      return (
        <div>
          <OpTitle>
            {action}
            {named}
          </OpTitle>
          {category !== null ? (
            <RuleText category={category} text={text} />
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Правило удалено — обновите черновик.</div>
          )}
        </div>
      );
    }

    default: {
      const exhaustive: never = op;
      throw new Error(`unknown draft op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function OpTitle({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 8 }}>{children}</div>;
}

function RuleText({ category, text }: { category: AgentRule['category']; text: string }) {
  return (
    <div className="sunken-box" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          alignSelf: 'flex-start',
          fontSize: 10.5,
          fontWeight: 700,
          padding: '3px 8px',
          borderRadius: 6,
          background: 'var(--accent-a14)',
          color: 'var(--accent)',
        }}
      >
        {ruleCategoryLabel(category)}
      </span>
      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

/** One line of a note's body, tagged against the other side. */
interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

/** Above this many cells, the ordinary O(n·m) alignment below is not worth doing — a note
 * can run to 200 000 characters (`BODY_MAX`, `server/src/lib/knowledge/note.ts`), and a diff
 * that hangs the tab is worse than one that skips aligning and simply shows both sides whole. */
const MAX_DIFF_CELLS = 250_000;

/**
 * A line-level diff, old against new — the longest common subsequence of lines, walked back
 * into a same/removed/added sequence. Ordinary for a note body, which is exactly what this
 * exists to read: line by line, the same shape a `git diff` of the same text would show.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: 'add', text: b[j]! });
    j += 1;
  }
  return out;
}

function NoteDiff({ oldBody, newBody }: { oldBody: string; newBody: string }) {
  const lines = useMemo(() => diffLines(oldBody, newBody), [oldBody, newBody]);

  if (oldBody === newBody) {
    return <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Текст не меняется.</div>;
  }

  return (
    <div
      className="sunken-box mono"
      style={{
        padding: '8px 0',
        fontSize: 11.5,
        lineHeight: 1.6,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            padding: '0 12px',
            whiteSpace: 'pre-wrap',
            background:
              line.kind === 'del' ? 'var(--danger-a10)' : line.kind === 'add' ? 'var(--accent-a10)' : undefined,
            color: line.kind === 'same' ? 'var(--text-3)' : line.kind === 'del' ? 'var(--danger)' : 'var(--accent)',
          }}
        >
          {line.kind === 'del' ? '− ' : line.kind === 'add' ? '+ ' : '  '}
          {line.text === '' ? ' ' : line.text}
        </div>
      ))}
    </div>
  );
}
