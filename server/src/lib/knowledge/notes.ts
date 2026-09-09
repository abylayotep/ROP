import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbChunks, kbLinks, kbNotes } from '../../db/schema.js';
import { parseLinks } from './links.js';
import { parseNote } from './note.js';
import { TITLE_MAX } from './split.js';

export interface SaveNoteInput {
  agentId: string;
  noteId?: string;
  path: string;
  body: string;
  sourceId?: string | null;
  edited?: boolean;
}

/** «Заметка › Раздел», numbered when one section became several pieces. */
export function chunkTitle(noteTitle: string, heading: string, index: number, total: number): string {
  const base = heading === '' ? noteTitle : `${noteTitle} › ${heading}`;
  const numbered = total > 1 ? `${base} (${index + 1})` : base;
  return numbered.length <= TITLE_MAX ? numbered : `${numbered.slice(0, TITLE_MAX - 1)}…`;
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
 */
async function resolveLinks(tx: Db, agentId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE kb_links l
    SET to_note_id = n.id
    FROM kb_notes n
    WHERE l.agent_id = ${agentId}
      AND n.agent_id = ${agentId}
      AND lower(n.title) = lower(l.target)
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
    updatedAt: new Date(),
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

/** Deleting a note takes its chunks and its outgoing links; links pointing at it go broken. */
export async function deleteNote(tx: Db, agentId: string, noteId: string): Promise<void> {
  await tx.delete(kbNotes).where(and(eq(kbNotes.id, noteId), eq(kbNotes.agentId, agentId)));
  await resolveLinks(tx, agentId);
}
