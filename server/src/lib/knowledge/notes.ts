import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbChunks, kbLinks, kbNotes } from '../../db/schema.js';
import { parseLinks } from './links.js';
import { parseNote } from './note.js';
import { clampTitle, TITLE_MAX } from './split.js';

export interface SaveNoteInput {
  agentId: string;
  noteId?: string;
  path: string;
  body: string;
  sourceId?: string | null;
  edited?: boolean;
}

/**
 * «Заметка › Раздел», numbered when one section became several pieces.
 *
 * Clamped before the `" (n)"` suffix is appended, not after: shares `split.ts`'s `clampTitle`
 * so the two splitters cut the same way. Clamping the numbered string as a whole would let an
 * over-long base eat the suffix in the cut, and every piece of a long section would then come
 * back under the same truncated title — the opposite of what the number is for.
 */
export function chunkTitle(noteTitle: string, heading: string, index: number, total: number): string {
  const base = heading === '' ? noteTitle : `${noteTitle} › ${heading}`;
  if (total <= 1) return clampTitle(base);
  const suffix = ` (${index + 1})`;
  return `${clampTitle(base, TITLE_MAX - suffix.length)}${suffix}`;
}

/** The last path segment. Folders are everything before it and are not stored anywhere. */
const titleOf = (path: string): string => path.split('/').pop()!.trim();

/**
 * Point every link in this agent at the note that now carries its title, and unpoint the ones
 * whose title nothing carries any more.
 *
 * Whole-agent rather than per-note: a note created, renamed or deleted changes the meaning of
 * links written in notes we are not touching, and resolving only the note in hand is what
 * would leave a link broken until somebody happened to re-save the note holding it.
 *
 * Titles are not unique — the unique index is on `(agent_id, path)`, so `Товары/Доставка` and
 * `Услуги/Доставка` can both carry the title «Доставка». An `UPDATE … FROM` joined straight
 * against `kb_notes` would then match a link against both rows, and which one it keeps is
 * whatever the planner happens to pick — a link could point at one note today and the other
 * tomorrow with no change anyone made. The `DISTINCT ON` subquery below picks exactly one row
 * per lowercased title, oldest `created_at` first and `id` as a tiebreaker for notes created in
 * the same instant: the oldest note is the one whose title existed first and is least likely to
 * be the one somebody is about to rename away, and «oldest wins» is an answer the writer of the
 * ambiguous link can see and explain, unlike an answer that depends on query planning.
 */
async function resolveLinks(tx: Db, agentId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE kb_links l
    SET to_note_id = n.id
    FROM (
      SELECT DISTINCT ON (lower(title)) id, lower(title) AS title
      FROM kb_notes
      WHERE agent_id = ${agentId}
      ORDER BY lower(title), created_at ASC, id ASC
    ) n
    WHERE l.agent_id = ${agentId}
      AND n.title = lower(l.target)
      AND l.to_note_id IS DISTINCT FROM n.id`);
  await tx.execute(sql`
    UPDATE kb_links l
    SET to_note_id = NULL
    WHERE l.agent_id = ${agentId}
      AND l.to_note_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM kb_notes n
        WHERE n.agent_id = ${agentId} AND n.id = l.to_note_id AND lower(n.title) = lower(l.target))`);
}

/**
 * Write a note and everything derived from it, in one transaction.
 *
 * The chunks are deleted and written again rather than diffed: a diff would have to decide
 * which old section a new one «is», and that guess is exactly what the page importer learned
 * not to make.
 *
 * «One transaction» is a promise this function only keeps if its caller does: `tx` must
 * already be inside `db.transaction(...)`, because `saveNote` itself never opens one. Pass the
 * plain `db` handle instead and a crash between the chunk rewrite and the link rewrite leaves
 * the note updated with its old chunks or a half-written link set, none of it rolled back.
 */
export async function saveNote(tx: Db, input: SaveNoteInput): Promise<typeof kbNotes.$inferSelect> {
  const parsed = parseNote(input.body);
  const title = titleOf(input.path);
  const values = {
    agentId: input.agentId,
    path: input.path,
    title,
    body: input.body,
    kind: parsed.kind,
    tags: parsed.tags,
    sourceId: input.sourceId ?? null,
    ...(input.edited === undefined ? {} : { edited: input.edited }),
    // Postgres's own clock, not the app server's: `api/drafts.ts`'s coach-draft route compares
    // this column against `coach_messages.created_at` (`defaultNow()`, also Postgres's clock)
    // to catch an edit that lands after a coach proposal was written — a comparison that is
    // only trustworthy when both sides are stamped by the same clock.
    updatedAt: sql`now()`,
  };

  const [note] = input.noteId
    ? await tx.update(kbNotes).set(values)
        .where(and(eq(kbNotes.id, input.noteId), eq(kbNotes.agentId, input.agentId))).returning()
    : await tx.insert(kbNotes).values(values).returning();
  if (!note) throw new Error('note not found');

  await tx.delete(kbChunks).where(eq(kbChunks.noteId, note.id));
  const byHeading = new Map<string, number>();
  for (const section of parsed.sections) {
    byHeading.set(section.heading, (byHeading.get(section.heading) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const rows = parsed.sections.map((section, ordinal) => {
    const index = seen.get(section.heading) ?? 0;
    seen.set(section.heading, index + 1);
    return {
      agentId: input.agentId,
      noteId: note.id,
      ordinal,
      heading: section.heading,
      title: chunkTitle(title, section.heading, index, byHeading.get(section.heading)!),
      content: section.content,
      kind: parsed.kind,
    };
  });
  if (rows.length > 0) await tx.insert(kbChunks).values(rows);

  await tx.delete(kbLinks).where(eq(kbLinks.fromNoteId, note.id));
  const targets = parseLinks(input.body);
  if (targets.length > 0) {
    await tx.insert(kbLinks).values(
      targets.map((target) => ({ agentId: input.agentId, fromNoteId: note.id, target })),
    );
  }
  await resolveLinks(tx, input.agentId);
  return note;
}

/**
 * Deleting a batch of notes at once takes their chunks and their outgoing links with them —
 * the FK cascades on `kb_chunks.note_id` and `kb_links.from_note_id` do that for however many
 * ids are in one `DELETE` — and links pointing at any of them go broken, resolved once for
 * the whole batch rather than once per note.
 *
 * `applyReimport` used to call `deleteNote` in a loop, one `resolveLinks` per stale note: a
 * legacy page source can own hundreds of those after migration `0012`, and `resolveLinks`
 * scans every note and every link this agent has, so a loop of them turned one reimport into
 * O(stale notes × agent size) work for no reason the single bulk delete below doesn't already
 * cover.
 */
export async function deleteNotes(tx: Db, agentId: string, noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  await tx.delete(kbNotes).where(and(eq(kbNotes.agentId, agentId), inArray(kbNotes.id, noteIds)));
  await resolveLinks(tx, agentId);
}

/** Deleting a note takes its chunks and its outgoing links; links pointing at it go broken. */
export async function deleteNote(tx: Db, agentId: string, noteId: string): Promise<void> {
  await deleteNotes(tx, agentId, [noteId]);
}
