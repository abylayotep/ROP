import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

/**
 * Proves migration 0013 (the one-way move from `agents.instructions` to `agent_rules`) on a
 * disposable database, not the shared `rakurs_test` one `withDb()` truncates: by the time any
 * `withDb()`-backed test's `beforeEach` runs, `agents.instructions` no longer exists as a
 * column, so there is no pre-migration state left to seed. This migration runs exactly once
 * against a customer's real text, and has already cost three bugs found by reading rather
 * than by a test — a dropped over-long sentence, colliding `position` values, and a stranded
 * `\r` — so it has earned the same scratch-database treatment as `knowledge-vault-migration.
 * test.ts` (migration 0012), one migration earlier. See `helpers/migration-db.ts` for the
 * shared journal-walking code both tests apply migrations by hand with.
 */

const TARGET_TAG = '0013_harsh_tony_stark';

async function seedAgent(
  sql: postgres.Sql,
  opts: { accountName: string; agentName: string; instructions?: string },
): Promise<string> {
  const [account] = await sql`INSERT INTO accounts (name) VALUES (${opts.accountName}) RETURNING id`;
  if (opts.instructions === undefined) {
    // No `instructions` column in the INSERT at all — the never-configured agent, relying on
    // the table's own `DEFAULT ''` (added in migration 0008) rather than an explicit empty
    // string.
    const [agent] =
      await sql`INSERT INTO agents (account_id, name) VALUES (${account!.id}, ${opts.agentName}) RETURNING id`;
    return agent!.id as string;
  }
  const [agent] = await sql`
    INSERT INTO agents (account_id, name, instructions) VALUES (${account!.id}, ${opts.agentName}, ${opts.instructions})
    RETURNING id
  `;
  return agent!.id as string;
}

/** A sentence of exactly `n` characters, ending in a period, built from repeated filler. */
function sentenceOfLength(label: string, n: number): string {
  const filler = `${label} слово `;
  let s = '';
  while (s.length < n - 1) s += filler;
  return `${s.slice(0, n - 1)}.`;
}

/** `n` characters with no `.`, `!` or `?` anywhere in them — no sentence boundary at all. */
function unpunctuatedTextOfLength(n: number): string {
  const filler = 'слово без точки ';
  let s = '';
  while (s.length < n) s += filler;
  return s.slice(0, n);
}

describe('migration 0013: agents.instructions becomes agent_rules', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;

  let ordinaryAgentId: string;
  const ordinaryParagraphs = [
    'Здравствуйте! Это первый абзац старых инструкций.',
    'Это второй абзац, с другим текстом и другой мыслью.',
    'А это третий и последний абзац исходного поля.',
  ];

  let noPunctuationAgentId: string;
  const noPunctuationSentence = unpunctuatedTextOfLength(900);

  let longSentencesAgentId: string;
  const longSentences = [
    sentenceOfLength('первое', 90),
    sentenceOfLength('второе', 95),
    sentenceOfLength('третье', 85),
    sentenceOfLength('четвертое', 100),
    sentenceOfLength('пятое', 110),
    sentenceOfLength('шестое', 80),
  ]; // combined > 500, each individually well under it
  const longParagraph = longSentences.join(' ');

  let posAgentAId: string;
  let posAgentBId: string;
  // Two over-long paragraphs on the same agent, each splitting into exactly two sentences —
  // the shape that collided under the brief's original `position = 1000 + s.ord` scheme,
  // where `s.ord` restarts at 1 inside every paragraph and never sees the other paragraph's
  // ordinal.
  function twoLongParagraphs(label: string): string {
    const para1 = [sentenceOfLength(`${label}-1a`, 260), sentenceOfLength(`${label}-1b`, 260)].join(' ');
    const para2 = [sentenceOfLength(`${label}-2a`, 260), sentenceOfLength(`${label}-2b`, 260)].join(' ');
    return [para1, para2].join('\n\n');
  }

  let crlfAgentId: string;
  const crlfParagraphs = ['Первый абзац перед CRLF.', 'Второй абзац после CRLF.'];
  const crlfInstructions = crlfParagraphs.join('\r\n\r\n');

  let loneCrAgentId: string;
  // A bare `\r` in the middle of one paragraph — not a paragraph separator, just a stray
  // control character the way a lone Mac-classic or mid-edit line ending would appear.
  const loneCrInstructions = 'Строка один\rСтрока два, без разрыва абзаца.';

  let emptyStringAgentId: string;
  let neverConfiguredAgentId: string;

  let exact500AgentId: string;
  const exact500Paragraph = sentenceOfLength('ровно', 500);

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });

    for (const tag of tagsBefore(TARGET_TAG)) {
      await runMigration(scratchSql, tag);
    }

    ordinaryAgentId = await seedAgent(scratchSql, {
      accountName: 'Обычный',
      agentName: 'Обычный агент',
      instructions: ordinaryParagraphs.join('\n\n'),
    });

    noPunctuationAgentId = await seedAgent(scratchSql, {
      accountName: 'Без пунктуации',
      agentName: 'Агент без пунктуации',
      instructions: noPunctuationSentence,
    });

    longSentencesAgentId = await seedAgent(scratchSql, {
      accountName: 'Длинный абзац',
      agentName: 'Агент с длинным абзацем',
      instructions: longParagraph,
    });

    posAgentAId = await seedAgent(scratchSql, {
      accountName: 'Позиции А',
      agentName: 'Агент А (позиции)',
      instructions: twoLongParagraphs('A'),
    });
    posAgentBId = await seedAgent(scratchSql, {
      accountName: 'Позиции Б',
      agentName: 'Агент Б (позиции)',
      instructions: twoLongParagraphs('B'),
    });

    crlfAgentId = await seedAgent(scratchSql, {
      accountName: 'CRLF',
      agentName: 'Агент CRLF',
      instructions: crlfInstructions,
    });

    loneCrAgentId = await seedAgent(scratchSql, {
      accountName: 'Одинокий CR',
      agentName: 'Агент с одиноким CR',
      instructions: loneCrInstructions,
    });

    emptyStringAgentId = await seedAgent(scratchSql, {
      accountName: 'Пустая строка',
      agentName: 'Агент с пустой строкой',
      instructions: '',
    });
    neverConfiguredAgentId = await seedAgent(scratchSql, {
      accountName: 'Никогда не настраивался',
      agentName: 'Агент без настройки',
      // `instructions` intentionally omitted — see `seedAgent`.
    });

    exact500AgentId = await seedAgent(scratchSql, {
      accountName: 'Ровно 500',
      agentName: 'Агент ровно 500',
      instructions: exact500Paragraph,
    });

    await runMigration(scratchSql, TARGET_TAG);
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  type RuleRow = {
    id: string;
    agent_id: string;
    category: string;
    text: string;
    origin: string;
    position: number;
  };

  async function rulesFor(agentId: string): Promise<RuleRow[]> {
    return (await scratchSql<RuleRow[]>`
      SELECT id, agent_id, category, text, origin, position FROM agent_rules
      WHERE agent_id = ${agentId} ORDER BY position
    `) as unknown as RuleRow[];
  }

  it('turns ordinary paragraphs into ordered business rules whose concatenation reconstructs the original', async () => {
    const rules = await rulesFor(ordinaryAgentId);
    expect(rules).toHaveLength(ordinaryParagraphs.length);
    expect(rules.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rules.map((r) => r.text)).toEqual(ordinaryParagraphs);
    for (const rule of rules) {
      expect(rule.category).toBe('business');
      expect(rule.origin).toBe('manual');
    }
    expect(rules.map((r) => r.text).join('\n\n')).toBe(ordinaryParagraphs.join('\n\n'));
  });

  it('splits a paragraph over 500 characters on sentence boundaries, and no rule exceeds 500', async () => {
    const rules = await rulesFor(longSentencesAgentId);
    expect(longParagraph.length).toBeGreaterThan(500);
    expect(rules).toHaveLength(longSentences.length);
    expect(rules.map((r) => r.text)).toEqual(longSentences);
    for (const rule of rules) {
      expect(rule.text.length).toBeLessThanOrEqual(500);
    }
  });

  it('chunks a single sentence over 500 characters with no punctuation, rather than dropping it', async () => {
    const rules = await rulesFor(noPunctuationAgentId);
    expect(noPunctuationSentence.length).toBeGreaterThan(500);
    // Not one row (it would exceed the column's practical cap) and not zero rows (the bug the
    // first fix caught: the brief's own draft excluded an over-long sentence from every
    // branch, discarding it once `DROP COLUMN instructions` ran).
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.text.length).toBeLessThanOrEqual(500);
      expect(rule.text.length).toBeGreaterThan(0);
    }
    // No separator was consumed between fixed-size pieces (unlike a sentence split, which eats
    // whitespace) — the plain concatenation must reproduce every character.
    expect(rules.map((r) => r.text).join('')).toBe(noPunctuationSentence);
  });

  it('gives each agent unique, gapless positions starting at 0, and never interleaves two agents', async () => {
    const [rulesA, rulesB] = await Promise.all([rulesFor(posAgentAId), rulesFor(posAgentBId)]);

    // Each agent has two over-long paragraphs, each splitting into two sentences: 4 fragments.
    expect(rulesA).toHaveLength(4);
    expect(rulesB).toHaveLength(4);

    for (const rules of [rulesA, rulesB]) {
      const positions = rules.map((r) => r.position);
      expect(positions).toEqual([0, 1, 2, 3]);
      expect(new Set(positions).size).toBe(4);
    }

    // No text belongs to the wrong agent, and no agent's fragment carries the other's label.
    for (const rule of rulesA) expect(rule.text.startsWith('A-')).toBe(true);
    for (const rule of rulesB) expect(rule.text.startsWith('B-')).toBe(true);
  });

  it('leaves no carriage return in any rule for paragraphs joined by \\r\\n\\r\\n or a lone \\r', async () => {
    const crlfRules = await rulesFor(crlfAgentId);
    expect(crlfRules).toHaveLength(2);
    expect(crlfRules.map((r) => r.text)).toEqual(crlfParagraphs);
    for (const rule of crlfRules) {
      expect(rule.text).not.toContain('\r');
    }

    const loneCrRules = await rulesFor(loneCrAgentId);
    expect(loneCrRules).toHaveLength(1);
    expect(loneCrRules[0]!.text).not.toContain('\r');
    // The bare `\r` is normalized to a real newline, not dropped.
    expect(loneCrRules[0]!.text).toBe('Строка один\nСтрока два, без разрыва абзаца.');
  });

  it('produces no rules for an empty instructions field or an agent that never had one', async () => {
    const [emptyRules, neverConfiguredRules] = await Promise.all([
      rulesFor(emptyStringAgentId),
      rulesFor(neverConfiguredAgentId),
    ]);
    expect(emptyRules).toHaveLength(0);
    expect(neverConfiguredRules).toHaveLength(0);
  });

  it('leaves a paragraph of exactly 500 characters whole', async () => {
    expect(exact500Paragraph).toHaveLength(500);
    const rules = await rulesFor(exact500AgentId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.text).toBe(exact500Paragraph);
    expect(rules[0]!.text).toHaveLength(500);
  });

  it('drops agents.instructions', async () => {
    const [row] = await scratchSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agents' AND column_name = 'instructions'
    `;
    expect(row).toBeUndefined();
  });
});
