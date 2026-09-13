import { and, eq, gte, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbDrafts, kbGenerationProposals, testRuns } from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from '../knowledge/generation-types.js';
import { clampTitle } from '../knowledge/split.js';
import type { DraftBase, DraftOp } from './ops.js';

/** A rule or a note's body can run long; a draft's own title is read in a list, not a page. */
const TITLE_MAX = 80;

export type OpEdit =
  | { action: 'remove'; index: number; current: unknown }
  | { action: 'update'; index: number; current: unknown; body: string };

/** What names an op in a list. A create op names its own row; an update op names none
 * (`note_update` carries no path), so it reads the display name `baseOf` captured. */
export function opTitle(op: DraftOp, base: DraftBase): string {
  switch (op.op) {
    case 'note_create':
      return clampTitle(op.path, TITLE_MAX);
    case 'note_update':
      return clampTitle(base.noteNames?.[op.noteId] ?? 'Заметка', TITLE_MAX);
    case 'rule_create':
      return clampTitle(op.text, TITLE_MAX);
    case 'rule_update':
      return clampTitle(op.text ?? base.ruleNames?.[op.ruleId] ?? 'Правило', TITLE_MAX);
    default: {
      const exhaustive: never = op;
      throw new Error(`unknown draft op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A stable identity for a note op's topic across edits that shift its index; rules have none. */
export function topicKey(op: DraftOp): string | null {
  switch (op.op) {
    case 'note_create':
      return `path:${op.path}`;
    case 'note_update':
      return `note:${op.noteId}`;
    default:
      return null;
  }
}

/** JSON with object keys sorted: `jsonb` does not keep key order, so two equal ops can
 * stringify differently. */
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) =>
  inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : inner);

/** `staleOps` checks every row named in `base`, so a row no remaining op touches must leave it:
 * otherwise an edit to a note the owner already removed from the draft would still block apply. */
function pruneBase(base: DraftBase, ops: DraftOp[]): DraftBase {
  const noteIds = new Set(ops.flatMap((op) => (op.op === 'note_update' ? [op.noteId] : [])));
  const ruleIds = new Set(ops.flatMap((op) => (op.op === 'rule_update' ? [op.ruleId] : [])));
  const keep = (record: Record<string, string> | undefined, ids: Set<string>) =>
    record === undefined ? undefined : Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  const pruned: DraftBase = {
    notes: keep(base.notes, noteIds),
    noteNames: keep(base.noteNames, noteIds),
    rules: keep(base.rules, ruleIds),
    ruleNames: keep(base.ruleNames, ruleIds),
  };
  for (const key of Object.keys(pruned) as (keyof DraftBase)[]) {
    if (pruned[key] === undefined || Object.keys(pruned[key]!).length === 0) delete pruned[key];
  }
  return pruned;
}

/**
 * Rewrites one note op's body or removes the op from an open draft. The caller must not call
 * this while the draft has a run in flight (the route checks `isDraftRunning`).
 *
 * The op is named by index *and* by its last-seen value, so an edit made in another tab answers
 * 409 instead of editing whatever slid into that index. Every edit deletes the draft's own runs:
 * a run proves one exact set of ops. Removing an op rejects the generation proposals that fed
 * it, so the next generation does not bring the topic back, and shifts later indexes down. The
 * last op cannot be removed — an empty draft is «Отбросить».
 */
export async function editDraftOp(
  db: Db,
  input: { agentId: string; draftId: string; edit: OpEdit },
): Promise<typeof kbDrafts.$inferSelect> {
  const { agentId, draftId, edit } = input;
  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(kbDrafts).where(and(
      eq(kbDrafts.id, draftId), eq(kbDrafts.agentId, agentId),
    )).for('update');
    if (!draft) throw new ApiError(404, 'Черновик не найден');
    if (draft.status !== 'open') throw new ApiError(409, 'Черновик уже применён или отклонён');
    const target = draft.ops[edit.index];
    if (!target || canonicalJson(target) !== canonicalJson(edit.current)) {
      throw new ApiError(409, 'Черновик изменился — обновите страницу');
    }

    let ops: DraftOp[];
    let base = draft.base;
    if (edit.action === 'remove') {
      if (draft.ops.length === 1) {
        throw new ApiError(409, 'Это последняя тема черновика — отбросьте черновик целиком');
      }
      ops = draft.ops.filter((_, index) => index !== edit.index);
      base = pruneBase(draft.base, ops);
      await tx.update(kbGenerationProposals).set({
        status: 'rejected',
        selected: false,
        draftId: null,
        draftOpIndex: null,
        revision: sql`${kbGenerationProposals.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(kbGenerationProposals.draftId, draft.id),
        eq(kbGenerationProposals.draftOpIndex, edit.index),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ));
      await tx.update(kbGenerationProposals).set({
        draftOpIndex: sql`${kbGenerationProposals.draftOpIndex} - 1`,
      }).where(and(
        eq(kbGenerationProposals.draftId, draft.id),
        gte(kbGenerationProposals.draftOpIndex, edit.index + 1),
      ));
    } else {
      if (target.op !== 'note_create' && target.op !== 'note_update') {
        throw new ApiError(400, 'Изменить можно только текст темы или заметки');
      }
      ops = draft.ops.map((op, index) => (index === edit.index ? { ...target, body: edit.body } : op));
    }

    await tx.delete(testRuns).where(eq(testRuns.draftId, draft.id));
    const [updated] = await tx.update(kbDrafts).set({ ops, base }).where(eq(kbDrafts.id, draft.id)).returning();
    return updated!;
  });
}
