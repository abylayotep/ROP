import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNote } from '../src/lib/knowledge/note.js';

/**
 * Proves migration 0012 (the one-way move from `kb_items` to `kb_notes`/`kb_chunks`) on a
 * disposable database, not the shared `rakurs_test` one `withDb()` truncates: this migration
 * runs exactly once against a customer's real data, so the thing worth testing is the move
 * itself, not a schema left behind by it.
 *
 * Migrations before 0012 are applied by hand — reading `drizzle/meta/_journal.json` for the
 * ordered tag list, reading each `.sql` file, and splitting on `--> statement-breakpoint` —
 * because that is exactly what `drizzle-orm`'s own migrator does (see
 * `node_modules/drizzle-orm/migrator.js`), and doing it by hand is what lets this test stop
 * short of 0012 so it can seed `kb_items` before that migration consumes it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(HERE, '../drizzle');
const TARGET_TAG = '0012_married_mathemanic';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';

type JournalEntry = { idx: number; tag: string };

function tagsBefore(targetTag: string): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const target = journal.entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`No journal entry tagged ${targetTag}`);
  return journal.entries.filter((e) => e.idx < target.idx).map((e) => e.tag);
}

async function runMigration(sql: postgres.Sql, tag: string): Promise<void> {
  const text = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim().length === 0) continue;
    await sql.unsafe(statement);
  }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** One `kb_items` row, seeded with an id we choose so the note it becomes is easy to find. */
type SeedItem = {
  id: string;
  agentId: string;
  sourceId?: string | null;
  kind: string;
  title: string;
  content: string;
  edited?: boolean;
  createdAt: Date;
};

async function seedItem(sql: postgres.Sql, item: SeedItem): Promise<void> {
  await sql`
    INSERT INTO kb_items (id, agent_id, source_id, kind, title, content, edited, created_at, updated_at)
    VALUES (
      ${item.id}, ${item.agentId}, ${item.sourceId ?? null}, ${item.kind}, ${item.title},
      ${item.content}, ${item.edited ?? false}, ${item.createdAt}, ${item.createdAt}
    )
  `;
}

describe('migration 0012: kb_items becomes kb_notes/kb_chunks', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;

  // One agent (A) carries every duplicate-numbering edge case; a second agent (B) exists
  // only to prove numbering never crosses an agent boundary.
  let agentA: string;
  let agentB: string;
  let sourceId: string;

  const doorId = [randomUUID(), randomUUID(), randomUUID()];
  const tableLiteralId = randomUUID(); // titled "Стол (2)" outright
  const tableDupId = [randomUUID(), randomUUID()]; // two rows titled "Стол"
  const slashId = randomUUID();
  const contactId = randomUUID();
  const crossAgentDoorId = randomUUID();

  // Every id's seeded `kb_items.content`, kept alongside the seed calls below so the chunk
  // test can assert against the record's own original text rather than the note's body —
  // which, for a non-`other` kind, now carries a frontmatter block the chunk must not.
  const contentById = new Map<string, string>();

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });

    for (const tag of tagsBefore(TARGET_TAG)) {
      await runMigration(scratchSql, tag);
    }

    const [accountA] = await scratchSql`INSERT INTO accounts (name) VALUES ('Сафина А') RETURNING id`;
    const [agentARow] =
      await scratchSql`INSERT INTO agents (account_id, name) VALUES (${accountA!.id}, 'Агент А') RETURNING id`;
    agentA = agentARow!.id as string;

    const [accountB] = await scratchSql`INSERT INTO accounts (name) VALUES ('Сафина Б') RETURNING id`;
    const [agentBRow] =
      await scratchSql`INSERT INTO agents (account_id, name) VALUES (${accountB!.id}, 'Агент Б') RETURNING id`;
    agentB = agentBRow!.id as string;

    const [source] = await scratchSql`
      INSERT INTO kb_sources (agent_id, kind, title, status) VALUES (${agentA}, 'text', 'Импорт', 'ready') RETURNING id
    `;
    sourceId = source!.id as string;

    const t0 = new Date('2026-01-01T00:00:00Z');
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

    // Three records sharing a title, in one agent and kind: must number (2), (3) in
    // creation order.
    await seedItem(scratchSql, {
      id: doorId[0]!, agentId: agentA, kind: 'product', title: 'Дверь',
      content: 'Дверь первая.', createdAt: at(0),
    });
    contentById.set(doorId[0]!, 'Дверь первая.');
    await seedItem(scratchSql, {
      id: doorId[1]!, agentId: agentA, kind: 'product', title: 'Дверь',
      content: 'Дверь вторая.', createdAt: at(1),
    });
    contentById.set(doorId[1]!, 'Дверь вторая.');
    await seedItem(scratchSql, {
      id: doorId[2]!, agentId: agentA, kind: 'product', title: 'Дверь',
      content: 'Дверь третья.', createdAt: at(2),
    });
    contentById.set(doorId[2]!, 'Дверь третья.');

    // The case that breaks the old row_number()-per-title scheme: a record whose title
    // already ends in " (2)", alongside a duplicate pair of its base title. The naive
    // scheme numbers the second "Стол" to "Стол (2)", colliding with the literal title.
    await seedItem(scratchSql, {
      id: tableLiteralId, agentId: agentA, kind: 'product', title: 'Стол (2)',
      content: 'Стол особый.', createdAt: at(3),
    });
    contentById.set(tableLiteralId, 'Стол особый.');
    await seedItem(scratchSql, {
      id: tableDupId[0]!, agentId: agentA, kind: 'product', title: 'Стол',
      content: 'Стол первый.', createdAt: at(4),
    });
    contentById.set(tableDupId[0]!, 'Стол первый.');
    await seedItem(scratchSql, {
      id: tableDupId[1]!, agentId: agentA, kind: 'product', title: 'Стол',
      content: 'Стол второй.', createdAt: at(5),
    });
    contentById.set(tableDupId[1]!, 'Стол второй.');

    // A literal "/" in the title must not be read as a folder separator.
    await seedItem(scratchSql, {
      id: slashId, agentId: agentA, kind: 'qa', title: 'Доставка/Самовывоз',
      content: 'Забрать можно самому.', createdAt: at(6),
    });
    contentById.set(slashId, 'Забрать можно самому.');

    // A non-product kind, edited, with a source — to prove kind/edited/source_id survive.
    await seedItem(scratchSql, {
      id: contactId, agentId: agentA, kind: 'contact', title: 'Офис', sourceId,
      content: 'Алматы, Абая 10.', edited: true, createdAt: at(7),
    });
    contentById.set(contactId, 'Алматы, Абая 10.');

    // The same title under a different agent must not be numbered against agent A's.
    await seedItem(scratchSql, {
      id: crossAgentDoorId, agentId: agentB, kind: 'product', title: 'Дверь',
      content: 'Дверь в агенте Б.', createdAt: at(8),
    });
    contentById.set(crossAgentDoorId, 'Дверь в агенте Б.');

    await runMigration(scratchSql, TARGET_TAG);
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  async function noteFor(id: string) {
    const [row] = await scratchSql`SELECT * FROM kb_notes WHERE id = ${id}`;
    return row as
      | {
          id: string;
          agent_id: string;
          source_id: string | null;
          path: string;
          title: string;
          body: string;
          kind: string;
          edited: boolean;
        }
      | undefined;
  }

  it('numbers three same-titled records in creation order', async () => {
    const [first, second, third] = await Promise.all(doorId.map(noteFor));
    expect(first?.path).toBe('Товары/Дверь');
    expect(second?.path).toBe('Товары/Дверь (2)');
    expect(third?.path).toBe('Товары/Дверь (3)');

    // A note's title is its path's last segment: `saveNote` derives it that way on the very
    // next save, so the numbering above has to be reflected in `title` too, not just `path`
    // — a numbered duplicate whose column still says the bare `item.title` would have its
    // first save silently rename it and re-title every one of its chunks with it.
    expect(second?.title).toBe('Дверь (2)');
    expect(third?.title).toBe('Дверь (3)');
  });

  it('does not collide a pre-existing "(2)" suffix with a numbered duplicate', async () => {
    const literal = await noteFor(tableLiteralId);
    const [dup1, dup2] = await Promise.all(tableDupId.map(noteFor));

    expect(literal?.path).toBe('Товары/Стол (2)');
    expect(dup1?.path).toBe('Товары/Стол');
    // The naive row_number() scheme would also land here on "Товары/Стол (2)" — the
    // literal title's path — and abort the migration on the unique index.
    expect(dup2?.path).toBe('Товары/Стол (3)');

    const paths = new Set([literal?.path, dup1?.path, dup2?.path]);
    expect(paths.size).toBe(3);

    // `dup2`'s own `kb_items.title` was the bare "Стол" — the numbering that avoided the
    // path collision has to show up in `title` as well, or this note answers to "Стол" while
    // its path and every one of its chunks say "Стол (3)".
    expect(dup2?.title).toBe('Стол (3)');
  });

  it('keeps a literal "/" in a title out of the path hierarchy', async () => {
    const note = await noteFor(slashId);
    expect(note?.path).toBe('Вопросы-ответы/Доставка∕Самовывоз');
    // The title is the path's last segment, escaped exactly like the path — not the raw
    // `item.title`, which still has the literal "/" the path had to escape away.
    expect(note?.title).toBe('Доставка∕Самовывоз');
  });

  it('does not number the same title across two different agents', async () => {
    const note = await noteFor(crossAgentDoorId);
    expect(note?.agent_id).toBe(agentB);
    expect(note?.path).toBe('Товары/Дверь');
  });

  it('keeps id, kind, edited and source_id across the move', async () => {
    const note = await noteFor(contactId);
    expect(note?.id).toBe(contactId);
    expect(note?.kind).toBe('contact');
    expect(note?.edited).toBe(true);
    expect(note?.source_id).toBe(sourceId);
    expect(note?.path).toBe('Контакты/Офис');
  });

  /**
   * `kb_notes.kind` is not where `saveNote` gets a note's kind from — it reads
   * `parseNote(body).kind`, and `parseNote` returns `other` for a body with no frontmatter.
   * Writing the column alone would make every migrated note's kind survive exactly until
   * anyone next saves it, at which point it silently becomes `other` — a customer's whole
   * product catalog reclassifying to «Прочее» note by note as they work through it. Proven
   * here the way `saveNote` itself would see it: parsing the migrated body, not reading the
   * column.
   */
  it('carries a non-other kind as frontmatter, so it survives the next save', async () => {
    const contact = await noteFor(contactId);
    expect(parseNote(contact!.body).kind).toBe('contact');

    const product = await noteFor(doorId[0]!);
    expect(parseNote(product!.body).kind).toBe('product');

    const qa = await noteFor(slashId);
    expect(parseNote(qa!.body).kind).toBe('qa');

    // The frontmatter block sits in front of the record's own text, exactly as
    // `insertPasteNotes` writes it, and does not become part of what the agent quotes.
    expect(contact!.body).toBe('---\nkind: contact\n---\n\nАлматы, Абая 10.');
    expect(parseNote(contact!.body).sections).toEqual([{ heading: '', content: 'Алматы, Абая 10.' }]);
  });

  /**
   * A chunk's `content` is exactly what `turn.ts` quotes to a customer and what the search
   * tsvector indexes — so it has to be the record's own text, never the frontmatter block the
   * note's `body` now carries for a non-`other` kind. Building the chunk from `n.body` after
   * the loop (rather than from `item.content` inside it) would hand the agent that block
   * verbatim on every migrated `product`/`qa`/`procedure`/`contact` note — proven here by
   * comparing the chunk against the record's original seeded content, not the note's body.
   */
  it('builds each chunk from the record`s own text, not the note`s frontmatter-carrying body', async () => {
    const allIds = [
      ...doorId, tableLiteralId, ...tableDupId, slashId, contactId, crossAgentDoorId,
    ];

    const [noteCountRow] = await scratchSql<{ count: number }[]>`SELECT count(*)::int FROM kb_notes`;
    const [chunkCountRow] = await scratchSql<{ count: number }[]>`SELECT count(*)::int FROM kb_chunks`;
    expect(noteCountRow?.count).toBe(allIds.length);
    expect(chunkCountRow?.count).toBe(allIds.length);

    for (const id of allIds) {
      const note = await noteFor(id);
      const chunks = await scratchSql<
        { content: string; title: string }[]
      >`SELECT content, title FROM kb_chunks WHERE note_id = ${id}`;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(contentById.get(id));
      expect(chunks[0]!.title).toBe(note!.title);
    }

    // The sharpest case: a `contact` note's body carries the frontmatter block, but its
    // chunk must not — that block is not part of what the agent quotes.
    const contact = await noteFor(contactId);
    const [contactChunk] = await scratchSql<
      { content: string }[]
    >`SELECT content FROM kb_chunks WHERE note_id = ${contactId}`;
    expect(contact!.body.startsWith('---\n')).toBe(true);
    expect(contactChunk!.content.startsWith('---')).toBe(false);
    expect(contactChunk!.content).toBe('Алматы, Абая 10.');
  });

  it('drops kb_items', async () => {
    const [row] = await scratchSql<
      { to_regclass: string | null }[]
    >`SELECT to_regclass('public.kb_items')`;
    expect(row?.to_regclass).toBeNull();
  });
});
