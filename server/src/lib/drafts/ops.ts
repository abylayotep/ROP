import { and, eq, inArray, sql } from 'drizzle-orm';
import { categorySize, lockCategories, type Tx } from '../rules/lock.js';
import type { Db } from '../../db/client.js';
import { agentRules, kbNotes } from '../../db/schema.js';
import { clampTitle } from '../knowledge/split.js';
import { saveNote } from '../knowledge/notes.js';
import type { RuleCategory } from '../ai/rules.js';

/** One write a draft would make. A note operation goes through the editor's own save path. */
export type DraftOp =
  | { op: 'note_create'; path: string; body: string }
  | { op: 'note_update'; noteId: string; body: string }
  | { op: 'rule_create'; category: RuleCategory; text: string; warning?: string | null }
  | { op: 'rule_update'; ruleId: string; text?: string; enabled?: boolean };

/**
 * Thrown by `applyOps` when an update op names a row that is no longer there.
 *
 * A plain `Error` here used to reach a run route's handler unconverted and answer «Внутренняя
 * ошибка сервера» — true, but useless: the one thing an owner actually needs to hear is *what*
 * is gone. `kind` and `id` are what the route needs to look the display name up in the draft's
 * own `base` (`baseOf` below already photographed it) and name it in a proper 409, rather than
 * the caller having to parse a sentence back apart to find out which op failed.
 */
export class MissingDraftRowError extends Error {
  constructor(
    readonly kind: 'note' | 'rule',
    readonly id: string,
  ) {
    super(`draft ${kind}_update: ${kind} not found (${id})`);
    this.name = 'MissingDraftRowError';
  }
}

/**
 * The `updatedAt` of everything the ops touch, as ISO strings, taken when the draft was made.
 *
 * A draft is a promise that what was tested is what lands. This is how the promise is checked:
 * a note edited underneath the draft makes it false, and applying anyway would put an untested
 * change into the store the agent answers from.
 *
 * `noteNames` and `ruleNames` carry the path or the text captured at the same moment, keyed
 * the same way as `notes` / `rules` above. They exist for `staleOps` to report a row that has
 * since been deleted: nothing about a deleted row can be read from the table any more, so the
 * only name left to show an owner is the one this snapshot kept.
 */
export interface DraftBase {
  notes?: Record<string, string>;
  rules?: Record<string, string>;
  noteNames?: Record<string, string>;
  ruleNames?: Record<string, string>;
}

/** A rule's text can run to 500 characters (see `RULE_MAX` in `api/rules.ts`) — too long for
 * a one-line "what moved" list, so it is cut the same way an over-long chunk title is. */
const RULE_NAME_MAX = 80;
const ruleName = (text: string): string => clampTitle(text, RULE_NAME_MAX);

/**
 * Run a draft's ops against the store, in order.
 *
 * Called twice in this product's life, for two very different reasons. A **test run** opens
 * a transaction it means to roll back, calls this, lets the agent answer inside it, then
 * throws the transaction away — the store never moves, but the agent saw exactly what it
 * would see if the draft had landed. The **apply route** opens a transaction it means to
 * keep. Both callers get the same behavior because there is exactly one implementation: this
 * function does not know, and must not need to know, which of the two it is running under.
 *
 * The two note ops go through `saveNote` — the same path the editor itself writes through —
 * so `kb_chunks` and `kb_links` come out rebuilt exactly as they would from a person typing
 * the same change, never written to directly (see `notes.ts`). `note_update` carries no path
 * of its own (a draft edits a note's body, not its place in the vault), so the note's current
 * path is read back and passed through unchanged — dropping it would have `saveNote` write an
 * empty path over the real one, since it sets every column on every save.
 *
 * A `rule_create` places its row through the exact `lockCategories` / `categorySize` pair
 * `POST /rules` uses (`api/rules.ts`), rather than a second implementation of "count the
 * category, insert at the end": a from-scratch lock would use its own key and would not
 * serialize against a real concurrent reorder at all, which is worse than not locking, since
 * it would look safe. Reusing the same lock means a `rule_create` that lands while an owner is
 * mid-reorder in that category simply waits for `lockCategories` like any other write to it,
 * then counts the category fresh and lands at its true end — no duplicate position, no gap.
 *
 * Does **not** bump the agent's config version. A run applies these ops inside a transaction
 * it throws away, and a bump there would be a write the rollback happens to cover rather than
 * one we never made — it would look like a version bump that never actually shows up in any
 * committed row. The apply route bumps once, after this returns, inside the transaction it
 * keeps.
 */
export type NoteApplied = (opIndex: number, noteId: string) => void | Promise<void>;

export async function applyOps(tx: Db, agentId: string, ops: DraftOp[], onNoteApplied?: NoteApplied): Promise<void> {
  for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
    const op = ops[opIndex]!;
    switch (op.op) {
      case 'note_create': {
        const note = await saveNote(tx, { agentId, path: op.path, body: op.body });
        await onNoteApplied?.(opIndex, note.id);
        break;
      }

      case 'note_update': {
        const [current] = await tx
          .select({ path: kbNotes.path })
          .from(kbNotes)
          .where(and(eq(kbNotes.id, op.noteId), eq(kbNotes.agentId, agentId)));
        if (!current) throw new MissingDraftRowError('note', op.noteId);
        const note = await saveNote(tx, { agentId, noteId: op.noteId, path: current.path, body: op.body });
        await onNoteApplied?.(opIndex, note.id);
        break;
      }

      case 'rule_create': {
        await lockCategories(tx as unknown as Tx, agentId, [op.category]);
        const position = await categorySize(tx as unknown as Tx, agentId, op.category);
        await tx.insert(agentRules).values({
          agentId,
          category: op.category,
          text: op.text,
          warning: op.warning ?? null,
          position,
          origin: 'coach',
        });
        break;
      }

      case 'rule_update': {
        const [updated] = await tx
          .update(agentRules)
          .set({
            ...(op.text === undefined ? {} : { text: op.text }),
            ...(op.enabled === undefined ? {} : { enabled: op.enabled }),
            // Postgres's own clock — see `api/rules.ts`'s PATCH route for why every writer of
            // this column agrees on which clock stamps it.
            updatedAt: sql`now()`,
          })
          .where(and(eq(agentRules.id, op.ruleId), eq(agentRules.agentId, agentId)))
          .returning({ id: agentRules.id });
        if (!updated) throw new MissingDraftRowError('rule', op.ruleId);
        break;
      }

      default: {
        const exhaustive: never = op;
        throw new Error(`unknown draft op: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

type NoteUpdateOp = Extract<DraftOp, { op: 'note_update' }>;
type RuleUpdateOp = Extract<DraftOp, { op: 'rule_update' }>;
const isNoteUpdate = (op: DraftOp): op is NoteUpdateOp => op.op === 'note_update';
const isRuleUpdate = (op: DraftOp): op is RuleUpdateOp => op.op === 'rule_update';

/** The distinct note/rule ids a list of ops names via `note_update` / `rule_update`. */
const noteIdsOf = (ops: DraftOp[]): string[] => [...new Set(ops.filter(isNoteUpdate).map((op) => op.noteId))];
const ruleIdsOf = (ops: DraftOp[]): string[] => [...new Set(ops.filter(isRuleUpdate).map((op) => op.ruleId))];

/**
 * The `updatedAt` — and a display name — of every row a draft's `note_update` and
 * `rule_update` ops name, read as of right now.
 *
 * Only those two op kinds have anything to photograph: `note_create` and `rule_create` name
 * no existing row, so there is nothing underneath them that later writes could move.
 *
 * Takes `db`, not `tx`, because taking this photograph needs no atomicity of its own — it is
 * one read of however many rows the ops name, each independent of the others, and nothing
 * about the read has to line up with a write happening anywhere else. That said, `Db` is the
 * same type a transaction handle is cast to everywhere else in this codebase (see
 * `bumpConfigVersion`), so a caller that wants this photograph taken from inside its own
 * transaction — a draft-creation route writing the `kb_drafts` row and its base together, say
 * — can already pass that transaction's handle through the same `tx as unknown as Db` cast.
 * Nothing here would need to change for that; the parameter is named `db` only to say what the
 * common case is, not to forbid the other one.
 */
export async function baseOf(db: Db, agentId: string, ops: DraftOp[]): Promise<DraftBase> {
  const noteIds = noteIdsOf(ops);
  const ruleIds = ruleIdsOf(ops);
  const base: DraftBase = {};

  if (noteIds.length > 0) {
    const rows = await db
      .select({ id: kbNotes.id, path: kbNotes.path, updatedAt: kbNotes.updatedAt })
      .from(kbNotes)
      .where(and(eq(kbNotes.agentId, agentId), inArray(kbNotes.id, noteIds)));
    base.notes = {};
    base.noteNames = {};
    for (const row of rows) {
      base.notes[row.id] = row.updatedAt.toISOString();
      base.noteNames[row.id] = row.path;
    }
  }

  if (ruleIds.length > 0) {
    const rows = await db
      .select({ id: agentRules.id, text: agentRules.text, updatedAt: agentRules.updatedAt })
      .from(agentRules)
      .where(and(eq(agentRules.agentId, agentId), inArray(agentRules.id, ruleIds)));
    base.rules = {};
    base.ruleNames = {};
    for (const row of rows) {
      base.rules[row.id] = row.updatedAt.toISOString();
      base.ruleNames[row.id] = ruleName(row.text);
    }
  }

  return base;
}

/**
 * What has moved since `base` was taken, named the way an owner reads a list: a note's path,
 * a rule's text (clamped — see `ruleName`).
 *
 * A row counts as moved two ways. Its `updatedAt` no longer matches the base — this alone
 * already covers a note that was renamed since, not just one whose body changed, because
 * `saveNote` stamps `updatedAt` on every save regardless of which columns actually changed,
 * so a rename is never silently missed here. Or the row is gone outright — deleted out from
 * under a draft that still names it is exactly as stale as one edited out from under it, and
 * a person choosing whether to apply the draft needs to be told either way. A deleted row has
 * no path or text left to read, which is what `base.noteNames` / `base.ruleNames` are for:
 * the name this function reports for a deleted row is the one `baseOf` kept, not a fresh one,
 * because there is no fresher one to have.
 *
 * Takes `db` for the same reason `baseOf` does: this is a read with nothing to keep atomic,
 * called to decide *whether* to open a transaction at all — the apply route calls this first,
 * outside any transaction, and only opens one (to run `applyOps` for real) once nothing here
 * comes back stale.
 *
 * **What this can't see.** A neighbouring reorder or delete shifts a rule's `position`
 * through a raw `position ± 1` update (`shiftForMove` and the close-the-gap updates in
 * `api/rules.ts`) that touches only `position`, never `updatedAt` — so a rule that only moved
 * because some *other* rule in its category was reordered or deleted reads here as unchanged,
 * and this function will not name it. That is not this function's job to catch: every write
 * branch in `api/rules.ts` (create, both PATCH branches, delete — five call sites) bumps the
 * agent's `config_version` regardless of which rows it touches, and the apply route refuses
 * to apply any draft whose test run wasn't against the *current* `config_version`. So a draft
 * built before that reorder still cannot land silently — the owner is stopped either way, just
 * by the version check instead of by a named rule here. `staleOps` names what it can name;
 * `config_version` is the catch-all standing behind it for the rest.
 */
export async function staleOps(db: Db, agentId: string, ops: DraftOp[], base: DraftBase): Promise<string[]> {
  const stale: string[] = [];

  const noteIds = Object.keys(base.notes ?? {});
  if (noteIds.length > 0) {
    const rows = await db
      .select({ id: kbNotes.id, path: kbNotes.path, updatedAt: kbNotes.updatedAt })
      .from(kbNotes)
      .where(and(eq(kbNotes.agentId, agentId), inArray(kbNotes.id, noteIds)));
    const current = new Map(rows.map((row) => [row.id, row]));
    for (const id of noteIds) {
      const row = current.get(id);
      if (!row) {
        stale.push(base.noteNames?.[id] ?? id);
      } else if (row.updatedAt.toISOString() !== base.notes![id]) {
        stale.push(row.path);
      }
    }
  }

  const ruleIds = Object.keys(base.rules ?? {});
  if (ruleIds.length > 0) {
    const rows = await db
      .select({ id: agentRules.id, text: agentRules.text, updatedAt: agentRules.updatedAt })
      .from(agentRules)
      .where(and(eq(agentRules.agentId, agentId), inArray(agentRules.id, ruleIds)));
    const current = new Map(rows.map((row) => [row.id, row]));
    for (const id of ruleIds) {
      const row = current.get(id);
      if (!row) {
        stale.push(base.ruleNames?.[id] ?? id);
      } else if (row.updatedAt.toISOString() !== base.rules![id]) {
        stale.push(ruleName(row.text));
      }
    }
  }

  return stale;
}
