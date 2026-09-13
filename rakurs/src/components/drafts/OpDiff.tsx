import { useMemo, useState, type ReactNode } from 'react';
import * as api from '@/api';
import { renderMarkdown } from '@/components/knowledge/markdown';
import { MarkdownView } from '@/components/knowledge/NoteEditor';
import { Card } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { ruleCategoryLabel } from '@/lib/rule-categories';
import { draftTopics, topicName } from '@/lib/training-state';
import type { AgentRule, DraftOp, KbNoteDetail } from '@/types';

/**
 * The change a draft would make — read before a single case is run, because the table below
 * answers «стало отвечать лучше», not «стало значить то, что владелец думает».
 *
 * A new note is shown as it will read — rendered markdown under its topic name — because a
 * diff against an empty file is one long green block. An edited note gets a line-by-line diff
 * of its body: that is what changed, and the owner reads it line by line. A rule op does not — a
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

/** At or under this many ops every note card opens expanded; past it, the list would be a
 * wall of text, so cards start collapsed to their first lines. */
const EXPAND_ALL_MAX_OPS = 5;
/** Lines of a new note's body a collapsed card still shows. */
const PREVIEW_LINES = 3;
/** Cards shown before «Показать ещё» — a draft of eighty topics otherwise pushes the run and
 * «Применить» a long scroll away. */
export const OPS_PAGE = 10;

/** What the owner asked to do with one op; `DraftScreen` sends it to the server. */
export type OpEdit = { action: 'remove' } | { action: 'update'; body: string };

export function OpDiff({ agentId, ops, topics = false, onEdit }: {
  agentId: string;
  ops: DraftOp[];
  /** A chat-generation draft: every note op is one knowledge topic, so the card says so. */
  topics?: boolean;
  /** Present while the draft can still be edited; each card then offers «Изменить» and «Убрать». */
  onEdit?: (index: number, op: DraftOp, edit: OpEdit) => Promise<boolean>;
}) {
  // `ops` is the draft's own array, read fresh only when the draft itself reloads — a stable
  // reference the rest of the time, so this does not refetch on every render.
  const ctx = useApi<OpContext>((signal) => loadContext(agentId, ops, signal), [agentId, ops]);
  const expanded = ops.length <= EXPAND_ALL_MAX_OPS;
  const [shown, setShown] = useState(OPS_PAGE);
  const hidden = Math.max(0, ops.length - shown);

  return (
    <Card>
      <div className="draft-ops__heading">{topics ? `Темы (${draftTopics({ ops }).count})` : 'Изменение'}</div>
      {topics && (
        <p className="draft-ops__intro">
          Собрано из переписки WhatsApp. Каждая карточка — одна тема базы знаний: факты и готовые фразы.
          {onEdit ? ' Лишнюю тему уберите, неточную — поправьте.' : ''}
        </p>
      )}
      <Async state={ctx} skeleton={<Skeleton height={120} />}>
        {(loaded) => (
          <div className="draft-ops__list">
            {ops.slice(0, shown).map((op, i) => (
              <OpCard key={opKey(op, i)} op={op} ctx={loaded} defaultExpanded={expanded}
                onEdit={onEdit && ((edit) => onEdit(i, op, edit))} />
            ))}
            {hidden > 0 && (
              <button type="button" className="btn-sm draft-ops__more" onClick={() => setShown((n) => n + OPS_PAGE * 5)}>
                Показать ещё {Math.min(hidden, OPS_PAGE * 5)} из {hidden}
              </button>
            )}
          </div>
        )}
      </Async>
    </Card>
  );
}

/** Keeps a card's own state (expanded, editing) on its topic when an earlier card is removed. */
const opKey = (op: DraftOp, index: number): string =>
  op.op === 'note_create' ? `path:${op.path}` : op.op === 'note_update' ? `note:${op.noteId}` : `op:${index}`;

function OpCard({ op, ctx, defaultExpanded, onEdit }: {
  op: DraftOp;
  ctx: OpContext;
  defaultExpanded: boolean;
  onEdit?: (edit: OpEdit) => Promise<boolean>;
}) {
  switch (op.op) {
    case 'note_create':
      return (
        <NoteCard path={op.path} tag="Новая" body={op.body} defaultExpanded={defaultExpanded} onEdit={onEdit}
          collapsed={<NoteBody body={previewBody(op.body)} />}>
          <NoteBody body={op.body} />
        </NoteCard>
      );

    case 'note_update': {
      // `loadContext` fetched exactly this id — a note gone since would have thrown there and
      // surfaced through the outer `Async`'s own error state, not reached this branch at all.
      const note = ctx.notes.get(op.noteId)!;
      return (
        <NoteCard path={note.path} tag="Правка" body={op.body} defaultExpanded={defaultExpanded} onEdit={onEdit}
          collapsed={<div className="draft-topic__hint">Нажмите, чтобы увидеть, что изменится.</div>}>
          <NoteDiff oldBody={note.body} newBody={op.body} />
        </NoteCard>
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

/** The first non-blank lines of a body — what a collapsed card still lets the owner read. */
export function previewBody(body: string, lines = PREVIEW_LINES): string {
  return body.split('\n').filter((line) => line.trim() !== '').slice(0, lines).join('\n');
}

/**
 * One note op: the topic name (the path's last segment) as the title, the folder it lives in
 * underneath, and a header that toggles the body. A draft of forty topics opened expanded was
 * a page nobody scrolled to the end of, so past `EXPAND_ALL_MAX_OPS` cards start collapsed.
 * With `onEdit`, the header also offers «Изменить» (the body in a textarea) and «Убрать».
 */
function NoteCard({ path, tag, body, defaultExpanded, collapsed, onEdit, children }: {
  path: string;
  tag: string;
  body: string;
  defaultExpanded: boolean;
  collapsed: ReactNode;
  onEdit?: (edit: OpEdit) => Promise<boolean>;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = topicName(path);
  const folder = path.split('/').map((segment) => segment.trim()).filter(Boolean).slice(0, -1).join(' / ');

  async function submit(edit: OpEdit) {
    if (!onEdit || busy) return;
    setBusy(true);
    const ok = await onEdit(edit);
    // A removed card unmounts on success; only an update or a refusal leaves one to reset.
    if (edit.action === 'update' && ok) setEditing(null);
    setBusy(false);
  }

  function remove() {
    if (!window.confirm(`Убрать тему «${name}» из черновика? Она не попадёт в базу знаний.`)) return;
    void submit({ action: 'remove' });
  }

  return (
    <section className={`draft-topic${expanded || editing !== null ? ' draft-topic--expanded' : ''}`} aria-label={name}>
      <div className="draft-topic__head">
        <button type="button" className="draft-topic__header" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
          <span className="draft-topic__titles">
            <b className="draft-topic__title">{name}</b>
            {folder !== '' && <span className="draft-topic__folder">{folder}</span>}
          </span>
          <span className="draft-topic__tag">{tag}</span>
          <span className="draft-topic__toggle">{expanded ? 'Свернуть' : 'Показать всё'}</span>
        </button>
        {onEdit && editing === null && (
          <span className="draft-topic__actions">
            <button type="button" className="btn-quiet" disabled={busy} onClick={() => setEditing(body)}>Изменить</button>
            <button type="button" className="btn-quiet" disabled={busy} onClick={remove}>Убрать</button>
          </span>
        )}
      </div>
      <div className="draft-topic__body">
        {editing !== null ? (
          <div className="draft-topic__editor">
            <textarea aria-label={`Текст темы «${name}»`} value={editing} onChange={(e) => setEditing(e.target.value)} />
            <div className="draft-topic__editor-actions">
              <button type="button" className="btn-sm" disabled={busy || editing.trim() === '' || editing === body}
                onClick={() => void submit({ action: 'update', body: editing })}>
                {busy ? 'Сохраняем…' : 'Сохранить'}
              </button>
              <button type="button" className="btn-quiet" disabled={busy} onClick={() => setEditing(null)}>Отмена</button>
            </div>
          </div>
        ) : expanded ? children : collapsed}
      </div>
    </section>
  );
}

/** A proposed body read as the note will read once applied, not as a diff against nothing. */
function NoteBody({ body }: { body: string }) {
  if (body.trim() === '') return <div className="draft-topic__hint">Текст пуст.</div>;
  return <div className="draft-topic__prose"><MarkdownView nodes={renderMarkdown(body, new Set())} targets={null} /></div>;
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
