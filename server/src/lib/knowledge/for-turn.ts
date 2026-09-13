import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbChunks, kbNotes } from '../../db/schema.js';
import { kbChunkColumns, searchKnowledge, type KbRow } from './search.js';

/**
 * How much knowledge, in characters, still travels whole instead of being searched.
 *
 * About 8 000 tokens of Russian: the same order as the six-record worst case search was
 * already allowed, so a small store costs no more than a large one did.
 */
export const WHOLE_STORE_CHARS = 24_000;

/** How many recent customer messages make up the search query for a large store. */
const QUERY_MESSAGES = 3;

/**
 * The knowledge one turn carries.
 *
 * A small store goes whole. Search reads only the words of the question, with a Russian
 * stemmer: a Kazakh «бағасы қанша» or a bare «Астана» answering the agent's own question
 * matched nothing, and the agent handed a price it had on file to a colleague. A business
 * with a few pages of notes loses nothing by the agent reading all of them.
 *
 * A large store is searched with the last few customer messages rather than the last one, so
 * a short answer still carries the topic the conversation is on.
 */
export async function knowledgeForTurn(
  db: Db, agentId: string, customerMessages: readonly string[], limit: number,
): Promise<KbRow[]> {
  const [size] = await db
    .select({ chars: sql<number>`coalesce(sum(length(${kbChunks.title}) + length(${kbChunks.content})), 0)` })
    .from(kbChunks)
    .where(eq(kbChunks.agentId, agentId));
  if (Number(size?.chars ?? 0) <= WHOLE_STORE_CHARS) {
    return db
      .select(kbChunkColumns)
      .from(kbChunks)
      .innerJoin(kbNotes, eq(kbNotes.id, kbChunks.noteId))
      .where(eq(kbChunks.agentId, agentId))
      .orderBy(asc(kbNotes.path), asc(kbChunks.ordinal));
  }
  const query = customerMessages.slice(-QUERY_MESSAGES).join(' ');
  return (await searchKnowledge(db, agentId, query, limit)).map(({ chunk }) => chunk);
}
