import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agents, kbChunks } from '../src/db/schema.js';
import { saveNote } from '../src/lib/knowledge/notes.js';
import { searchKnowledge } from '../src/lib/knowledge/search.js';
import { withDb } from './helpers/db.js';

async function seedAgent(db: Db, name = 'Сафина') {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

// A one-section note is the fixture shape every existing case wants: one chunk, titled after
// the note itself, carrying the whole body. `kind` goes through frontmatter, the same path a
// real import writes, rather than a column no vault note is ever saved without.
async function seedNote(
  db: Db,
  agentId: string,
  title: string,
  content: string,
  kind = 'other',
) {
  const body = kind === 'other' ? content : `---\nkind: ${kind}\n---\n${content}`;
  await saveNote(db, { agentId, path: title, body });
}

describe('searchKnowledge', () => {
  it('finds a chunk by a word from its content', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы бесплатно, в Астану за 3000 тенге.');
    await seedNote(db, agentId, 'Гарантия', 'На все двери двенадцать месяцев.');

    // The word as the content spells it. The snowball stemmer does not fold «Астана» and
    // «Астану» together — it stems them to «аста» and «астан» — so the nominative would be
    // a test of the stemmer's dictionary rather than of this function. Stemming is proved
    // by «двери»/«дверей» below, on a word the stemmer does handle.
    const hits = await searchKnowledge(db, agentId, 'Астану', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.title).toBe('Доставка');
    expect(hits[0]?.rank).toBeGreaterThan(0);
    // The tsvector is machinery. It is not selected, so it cannot ride the API route into
    // stage 5's prompt, and the type says so — this asserts the query agrees with the type.
    expect(hits[0]?.chunk).not.toHaveProperty('search');
  });

  it('finds a word in a form it was not written in', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Двери', 'Продаём межкомнатные двери.');

    // The russian configuration stems: «дверей» and «двери» share a lexeme, and an
    // english configuration would treat them as two unrelated words.
    const hits = await searchKnowledge(db, agentId, 'дверей', 10);

    expect(hits).toHaveLength(1);
  });

  it('finds a chunk by its title', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Рассрочка', 'Через Kaspi Red.');

    expect(await searchKnowledge(db, agentId, 'рассрочка', 10)).toHaveLength(1);
  });

  it('returns nothing when nothing matches', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.');

    // An empty answer is the point: stage 5's agent is meant to say it cannot answer
    // rather than invent, and this is how it learns that. The OR fallback must not soften
    // it — words that match nothing match nothing on the second pass too.
    expect(await searchKnowledge(db, agentId, 'вертолёт', 10)).toEqual([]);
    expect(await searchKnowledge(db, agentId, 'вертолёт вездеход', 10)).toEqual([]);
  });

  it('returns nothing for a blank query without querying at all', async () => {
    // Asserting `[]` against a real database would pass with the early return deleted, because
    // an empty tsquery matches nothing anyway. A `db` that throws the moment it is asked for a
    // query is the only way to prove the claim the early return actually makes.
    const exploding = {
      select() {
        throw new Error('searchKnowledge issued a query for a blank input');
      },
    } as unknown as Db;

    expect(await searchKnowledge(exploding, 'any-agent', '   ', 10)).toEqual([]);
    expect(await searchKnowledge(exploding, 'any-agent', '', 10)).toEqual([]);
    // A query that is nothing but punctuation normalises to blank and stops here too.
    expect(await searchKnowledge(exploding, 'any-agent', ' - ', 10)).toEqual([]);
  });

  it('never crosses into another agent', async () => {
    const db = await withDb();
    const ours = await seedAgent(db, 'Сафина');
    const theirs = await seedAgent(db, 'Другая');
    await seedNote(db, theirs, 'Доставка', 'Возим по Алматы.');

    expect(await searchKnowledge(db, ours, 'Алматы', 10)).toEqual([]);
  });

  it('survives a query full of punctuation', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.');

    // websearch_to_tsquery never raises on operators a person typed by accident, which is
    // the whole reason it is used instead of to_tsquery. Asserting only that an array came
    // back would be satisfied by any implementation that does not throw, so each of these
    // is checked against what it actually parses to.
    //
    // '!!!' and '<->' reduce to an empty tsquery, 'а & | б' to the lone lexeme 'б', and the
    // unbalanced quote to the phrase 'незакрыт' <-> 'кавычк'. None occurs in the fixture.
    for (const query of ['!!!', 'а & | б', '"незакрытая кавычка', '<->']) {
      expect(await searchKnowledge(db, agentId, query, 10)).toEqual([]);
    }

    // Punctuation around a word that is in the fixture must not cost the match: all three
    // parse down to the single lexeme 'доставк' or 'алмат'.
    for (const query of ['доставка!!!', '"Алматы"', '...Алматы?!']) {
      const hits = await searchKnowledge(db, agentId, query, 10);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunk.title).toBe('Доставка');
    }
  });

  it('ranks a better match first and honours the limit', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка в Астану', 'Доставка в Астану занимает два дня.');
    await seedNote(db, agentId, 'Гарантия', 'Гарантия действует по всему Казахстану, включая Астану.');
    await seedNote(db, agentId, 'Оплата', 'Оплата картой или наличными в Астане.');

    // One word, because `websearch_to_tsquery` joins terms with AND: «доставка в Астану»
    // matches only the first chunk, and one strict hit is enough to keep the OR fallback
    // from running — so that query would prove nothing about ranking or the limit. All
    // three chunks match this one, and the one carrying it in its title outranks the rest.
    const hits = await searchKnowledge(db, agentId, 'Астану', 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]?.chunk.title).toBe('Доставка в Астану');
  });

  it('answers a whole question no single chunk matches word for word', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы бесплатно, в Астану за 3000 тенге.');
    await seedNote(db, agentId, 'Гарантия', 'На все двери двенадцать месяцев.');

    // Conjoined this is four lexemes, and no chunk carries «сколько» or «стоит» at all, so
    // the strict pass finds nothing. The delivery chunk is still the answer, and the OR
    // retry is what reaches it — this is the query stage 5's agent will actually be given.
    const hits = await searchKnowledge(db, agentId, 'сколько стоит доставка в Астану', 10);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunk.title).toBe('Доставка');
  });

  it('keeps the strict reading when the strict reading finds anything', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Рассрочка на двери', 'Рассрочка на двери через Kaspi Red.');
    await seedNote(db, agentId, 'Двери', 'Межкомнатные двери от 90 000 тенге.');

    // The first chunk carries every word, the second only «двери». The fallback must not
    // run: one chunk matched the question as asked, so the looser reading is not needed.
    const hits = await searchKnowledge(db, agentId, 'рассрочка на двери', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.title).toBe('Рассрочка на двери');
  });

  it('does not widen a query that excludes a word', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.');
    await seedNote(db, agentId, 'Гарантия', 'На все двери двенадцать месяцев.');

    // «вертолёт -доставка» parses to `'вертолет' & !'доставк'`. Swapping the operator would
    // make it `'вертолет' | !'доставк'`, which matches everything that merely lacks the
    // word «доставка» — the guarantee chunk, for a question about helicopters. A negation
    // is left conjoined, so a query that excluded its way to nothing stays nothing.
    expect(await searchKnowledge(db, agentId, 'вертолёт -доставка', 10)).toEqual([]);
  });

  it('reads a dash between words as punctuation, not as an exclusion', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Рассрочка', 'Kaspi Red — рассрочка на 3 месяца.');

    // «Kaspi Red - рассрочка» parses to `'kaspi' & 'red' & !'рассрочк'` — the dash excludes
    // the very word that answers the question, and the chunk is silently withheld.
    for (const query of ['Kaspi Red - рассрочка', 'рассрочка - какие условия']) {
      const hits = await searchKnowledge(db, agentId, query, 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.chunk.title).toBe('Рассрочка');
    }
  });

  it('reads a leading dash pasted from a list as punctuation', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Рассрочка', 'Через Kaspi Red.');
    await seedNote(db, agentId, 'Гарантия', 'На все двери двенадцать месяцев.');

    // «- рассрочка» parses to `!'рассрочк'`, which returns every chunk that does NOT answer
    // the question — here the guarantee, and nothing else.
    const hits = await searchKnowledge(db, agentId, '- рассрочка', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.title).toBe('Рассрочка');
  });

  it('still lets a dash written against a word exclude it', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.');
    await seedNote(db, agentId, 'Гарантия', 'На все двери двенадцать месяцев.');

    // The normalisation must not swallow a deliberate exclusion: no space after the dash,
    // so this stays `'вертолет' & !'доставк'` and finds nothing rather than everything else.
    expect(await searchKnowledge(db, agentId, 'вертолёт -доставка', 10)).toEqual([]);
  });

  it('reindexes a chunk when its content is edited', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.');
    const [row] = await db.select().from(kbChunks).where(eq(kbChunks.agentId, agentId));

    await db
      .update(kbChunks)
      .set({ content: 'Возим по Алматы и по Караганде.' })
      .where(eq(kbChunks.id, row!.id));

    // The whole point of generating the column: nothing reindexed this row, and nothing
    // had to remember to. The word was not there a moment ago.
    const hits = await searchKnowledge(db, agentId, 'Караганда', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.id).toBe(row!.id);
  });

  it('narrows to a kind inside the query, not after the limit', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Доставка по Алматы, доставка в Астану.', 'procedure');
    await seedNote(db, agentId, 'Дверь входная', 'Цена включает доставку.', 'product');

    // A limit of one, and the procedure outranks the product. A caller that asked for
    // everything and filtered the answer would be handed that one procedure and conclude
    // there is no product — the door is in the store, just below the cut.
    const hits = await searchKnowledge(db, agentId, 'доставка', 1, { kind: 'product' });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.title).toBe('Дверь входная');
  });

  it('narrows to a kind on the loose pass as well', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await seedNote(db, agentId, 'Доставка', 'Возим по Алматы.', 'procedure');
    await seedNote(db, agentId, 'Дверь входная', 'Цена включает доставку.', 'product');

    // No chunk carries every word, so the strict pass finds nothing and the query is retried
    // as OR. That second pass builds its own WHERE, and is where a narrowing added to only
    // one of them would let the other kind back in.
    const hits = await searchKnowledge(db, agentId, 'сколько стоит доставка', 10, {
      kind: 'product',
    });

    expect(hits.map((hit) => hit.chunk.title)).toEqual(['Дверь входная']);
  });

  it('finds the section that answers, not the note that contains it', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await saveNote(db, {
      agentId,
      path: 'Доставка',
      body: '## По городу\n1500 ₸.\n\n## Возврат\n14 дней, чек не нужен.',
    });

    const hits = await searchKnowledge(db, agentId, 'возврат чек', 20);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.chunk.title).toBe('Доставка › Возврат');
  });
});
