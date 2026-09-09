import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbChunks } from '../../db/schema.js';

/**
 * Russian, not the default.
 *
 * It stems and folds case, so «дверей» finds an item that says «двери», which the english
 * configuration would treat as two unrelated words.
 *
 * On Kazakh it does not merely fail to stem — it stems wrongly and inconsistently, cutting
 * endings it does not know: «жеткізу» becomes `жеткіз` while «жеткізуге» becomes `жеткізуг`,
 * so two forms of one word land on different lexemes and cannot find each other. A
 * Kazakh-speaking client will hit this. It is still the best single configuration available
 * for a Russian-language product, and fixing it properly means a second vector, not a
 * different setting here.
 *
 * Written once: the generated column in the schema and this query must agree, and two
 * literals that have to match are one edit away from not matching.
 */
export const TEXT_SEARCH_CONFIG = 'russian';

/**
 * An item as search returns it — every column except `search` itself.
 *
 * The tsvector is machinery, not content. It is large, it is derivable, and on its way to
 * stage 5 it would otherwise travel through the API route into the agent's prompt.
 */
export type KbRow = Omit<typeof kbChunks.$inferSelect, 'search'>;

/**
 * The columns a `KbRow` is made of, for every query that reads an item.
 *
 * Written once and shared with the routes, because `select()` means `SELECT *`: it fetches
 * the tsvector — kilobytes of derived machinery per row — and puts it one `JSON.stringify`
 * away from the wire. Naming the columns in one place is what makes `KbRow`'s promise true
 * of every reader rather than only of this file.
 */
export const kbChunkColumns = {
  id: kbChunks.id,
  agentId: kbChunks.agentId,
  noteId: kbChunks.noteId,
  ordinal: kbChunks.ordinal,
  heading: kbChunks.heading,
  title: kbChunks.title,
  content: kbChunks.content,
  kind: kbChunks.kind,
  createdAt: kbChunks.createdAt,
  updatedAt: kbChunks.updatedAt,
} as const;

export interface KnowledgeHit {
  chunk: KbRow;
  rank: number;
}

/** Narrowing applied inside the query. Stage 5 will add its own without a new function. */
export interface SearchOptions {
  /** Only items of this kind. Filtering the results instead would drop them after `limit`. */
  kind?: string;
}

/**
 * A hyphen that stands alone is punctuation; a hyphen against a word is an exclusion.
 *
 * `websearch_to_tsquery` reads any leading `-` as NOT, and Russian is written with the dash
 * as ordinary punctuation: «Kaspi Red - рассрочка» parses to `'kaspi' & 'red' & !'рассрочк'`,
 * which excludes the one item that answers the question, and «- рассрочка» pasted from a
 * bulleted list parses to `!'рассрочк'`, which returns every item that does not. Both are
 * silent — the person just gets the wrong answer.
 *
 * So a hyphen run that stands on its own between spaces, or opens the query, becomes a
 * space. One written tight against a word — «вертолёт -доставка» — is someone deliberately
 * excluding a term and is left alone, and so is one inside a word, «что-то» or «счёт-фактура».
 *
 * This is the only place the query is touched before Postgres parses it, and it must stay:
 * without it a dash typed the way people type it makes the store answer the opposite of
 * what it was asked.
 */
function normalizeQuery(query: string): string {
  return query.replace(/(^|\s)-+(?=\s|$)/g, '$1 ').trim();
}

/**
 * The only way anything reads the knowledge base.
 *
 * One signature so stage 5 can add an embedding column and a second ranker behind it
 * without touching a route or a screen.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`: a person typing into a search box will
 * eventually type an unbalanced quote or a bare `&`, and `to_tsquery` raises on those.
 *
 * Two passes, strict then loose. `websearch_to_tsquery` conjoins bare words, so a real
 * question — «сколько стоит доставка в Астану» — is four lexemes no single item carries,
 * and the item that answers it would be missed. Retried as OR, `ts_rank_cd` puts whatever
 * shares the most words first, so the looser reading costs precision only where precision
 * had already returned nothing.
 */
export async function searchKnowledge(
  db: Db,
  agentId: string,
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<KnowledgeHit[]> {
  const text = normalizeQuery(query);
  // A blank query matches everything in tsquery terms, which would hand the agent the whole
  // store as though it were relevant. Nothing is the honest answer, and returning it here
  // means no query is issued at all.
  if (text === '') return [];

  // Every narrowing belongs in the WHERE, next to the tenancy check and before `limit` is
  // applied. A caller that filtered the returned array instead would be filtering rows the
  // ranker had already cut off at `limit`: with more matches than that, the items it asked
  // for can be present in the store, ranked below the cut, and silently absent from what it
  // gets back. Both passes carry it for the same reason.
  const scope = and(
    eq(kbChunks.agentId, agentId),
    options.kind === undefined ? undefined : eq(kbChunks.kind, options.kind),
  );

  // Both passes read the same rows and differ only in the tsquery they are asked for.
  const run = async (tsquery: SQL): Promise<KnowledgeHit[]> => {
    const rank = sql<number>`ts_rank_cd(${kbChunks.search}, ${tsquery})`;

    const rows = await db
      .select({ chunk: kbChunkColumns, rank })
      .from(kbChunks)
      .where(and(scope, sql`${kbChunks.search} @@ ${tsquery}`))
      .orderBy(desc(rank))
      .limit(limit);

    return rows.map(({ chunk, rank: value }) => ({ chunk, rank: Number(value) }));
  };

  const strict = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${text})`;
  const hits = await run(strict);
  if (hits.length > 0) return hits;

  // Nothing matched every word, so ask for any of them. Rendering the parsed query back to
  // text and swapping its operators keeps Postgres as the only parser of what a person
  // typed — we never take the query apart ourselves.
  //
  // A phrase keeps its `<->`: someone who typed quotes asked for a phrase, not for its
  // words scattered. A negation is left alone entirely — `а & !б` loosened to `а | !б`
  // matches everything that merely lacks б, which is not a wider reading of the question
  // but a different question, so a negated query that found nothing stays found nothing.
  const loose = sql`(case
    when strpos(${strict}::text, '!') > 0 then ${strict}
    else replace(${strict}::text, ' & ', ' | ')::tsquery
  end)`;

  return run(loose);
}
