# Agent Coaching — Part 1: the rules

> Part of [the coaching plan](2026-09-08-agent-coaching.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-agent-coaching-design.md](../specs/2026-09-08-agent-coaching-design.md)

---

### Task 1: Rules and coach messages in the schema

**Files:**
- Modify: `server/src/db/schema.ts` (add `agentRules`, `coachMessages`; drop `agents.instructions`)
- Modify: `server/test/helpers/db.ts` (truncate list)
- Create: `server/drizzle/0013_*.sql` (generated, then hand-edited)
- Test: `server/test/coaching-schema.test.ts`

**Interfaces:**
- Produces: `agentRules`, `coachMessages` table objects; `RuleCategory = 'business' | 'tone' | 'order' | 'forbid'`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/coaching-schema.test.ts
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentRules, agents, coachMessages } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  ({ agentId } = await createAccountWithOwner(db, {
    company: 'Сафина', email: 'owner@example.com', password: 'correct-horse-battery',
  }));
});

describe('the coaching schema', () => {
  it('defaults a rule to enabled and remembers where it came from', async () => {
    const [rule] = await db.insert(agentRules)
      .values({ agentId, category: 'forbid', text: 'Не обещай скидку.', origin: 'coach', position: 0 })
      .returning();
    expect(rule!.enabled).toBe(true);
    expect(rule!.origin).toBe('coach');
  });

  it('takes a coach message with no proposal', async () => {
    const [message] = await db.insert(coachMessages)
      .values({ agentId, role: 'owner', text: 'Ты обещал скидку.', status: 'pending' })
      .returning();
    expect(message!.proposal).toBeNull();
  });

  it('deletes a rule with its agent', async () => {
    await db.insert(agentRules)
      .values({ agentId, category: 'tone', text: 'На «вы».', origin: 'manual', position: 0 });
    await db.delete(agents).where(eq(agents.id, agentId));
    expect(await db.select().from(agentRules)).toEqual([]);
  });

  it('no longer carries an instructions column on the agent', async () => {
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'agents'`);
    expect([...columns].map((row) => row.column_name)).not.toContain('instructions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/coaching-schema.test.ts`
Expected: FAIL — `agentRules` is not exported from the schema.

- [ ] **Step 3: Write the tables**

In `server/src/db/schema.ts`, delete the `instructions` column from `agents` and add:

```ts
/**
 * One rule the agent follows: how to speak, what to ask, what never to do, what we are.
 *
 * A row rather than a paragraph in a text field, because a rule has to be switchable and
 * orderable on its own — an owner testing whether a sentence caused a bad answer turns that
 * sentence off, and a wall of text has no off switch.
 */
export const agentRules = pgTable(
  'agent_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // 'business' | 'tone' | 'order' | 'forbid'. Four, because the prompt groups by them and a
    // free-form label would drift into forty groups nobody reads.
    category: text('category').notNull(),
    text: text('text').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // 'manual' | 'coach' — what the owner wrote against what they approved.
    origin: text('origin').notNull().default('manual'),
    // Order inside a category. The prompt follows it, so a reordered list reorders the rules
    // the model reads.
    position: integer('position').notNull().default(0),
    // Set when the owner insisted on a rule the fact check wanted to be a note. Shown beside
    // the rule, because a number in instructions is a number no record backs.
    warning: text('warning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_rules_agent_category_idx').on(t.agentId, t.category, t.position)],
);

/**
 * One turn of the coaching conversation.
 *
 * `proposal` is what the model suggests and nothing more: this table is the only thing the
 * coach routes write, and a proposal reaches the store only through a draft.
 */
export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // 'owner' | 'model'
    role: text('role').notNull(),
    text: text('text').notNull(),
    // A `CoachProposal`, or null on the owner's own lines and on a plain reply.
    proposal: jsonb('proposal').$type<CoachProposal>(),
    // 'pending' | 'drafted' | 'rejected'
    status: text('status').notNull().default('pending'),
    // The dialog this coaching started from, and the turn inside it, so the model reads what
    // the agent actually answered rather than what the owner remembers of it.
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    aiReplyId: uuid('ai_reply_id').references(() => aiReplies.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('coach_messages_agent_created_idx').on(t.agentId, t.createdAt)],
);
```

Add `import type { CoachProposal } from '../lib/ai/coach.js';` beside the existing type-only import of `CapiEventBody`, with the same one-line comment about staying a leaf module. `coach_messages.draft_id` is **not** added here — the table it points at does not exist until migration `0014` in the drafts plan.

- [ ] **Step 4: Generate the migration and add the data move**

Run: `npm run generate`. In the new `drizzle/0013_*.sql`, put the copy **before** the `ALTER TABLE agents DROP COLUMN instructions`:

```sql
--> statement-breakpoint
-- Every paragraph of the old instructions becomes one rule about the business, in order.
-- Nothing is classified into the other three categories: guessing an owner's intent during a
-- migration would silently change what their agent does, and re-categorising is one click.
INSERT INTO agent_rules (agent_id, category, text, origin, position)
SELECT a.id, 'business', trim(p.para), 'manual', p.ord - 1
FROM agents a,
     LATERAL regexp_split_to_table(a.instructions, '\n\s*\n') WITH ORDINALITY AS p(para, ord)
WHERE trim(p.para) <> '' AND length(trim(p.para)) <= 500;
--> statement-breakpoint
-- A paragraph too long for the column is cut on sentence boundaries instead of being lost.
INSERT INTO agent_rules (agent_id, category, text, origin, position)
SELECT a.id, 'business', trim(s.sentence), 'manual', 1000 + s.ord
FROM agents a,
     LATERAL regexp_split_to_table(a.instructions, '\n\s*\n') WITH ORDINALITY AS p(para, ord),
     LATERAL regexp_split_to_table(p.para, '(?<=[.!?])\s+') WITH ORDINALITY AS s(sentence, ord)
WHERE length(trim(p.para)) > 500 AND trim(s.sentence) <> '' AND length(trim(s.sentence)) <= 500;
```

- [ ] **Step 5: Add the tables to the truncate list**

In `server/test/helpers/db.ts`, add `coach_messages, agent_rules` before `agents` in the `truncate` statement.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/coaching-schema.test.ts test/schema.test.ts`
Expected: PASS. `ai-schema.test.ts` and any fixture setting `instructions` will now fail to compile — Task 2 fixes them; do not patch them here.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/test/helpers/db.ts server/test/coaching-schema.test.ts
git commit -m "Store the agent's character as rules"
```

---

### Task 2: The prompt reads rules

**Files:**
- Create: `server/src/lib/ai/rules.ts`
- Modify: `server/src/lib/ai/prompt.ts:360-380` (`instructionsSection`)
- Modify: `server/src/lib/ai/turn.ts` (load rules where it loaded the column)
- Modify: `server/test/ai-prompt.test.ts`, `server/test/ai-turn.test.ts`

**Interfaces:**
- Consumes: `agentRules`.
- Produces:
  - `export interface AgentRule { category: RuleCategory; text: string }`
  - `export function assembleRules(rules: AgentRule[]): string`
  - `export async function loadRules(db: Db, agentId: string): Promise<AgentRule[]>` — enabled only, ordered by category then `position`.
- `PromptAgent.instructions: string` keeps its type. The assembly happens above the prompt, so the prompt's seam stays one string wide.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/ai-rules.test.ts
import { describe, expect, it } from 'vitest';
import { assembleRules } from '../src/lib/ai/rules.js';

describe('assembleRules', () => {
  it('groups rules under their Russian headings in a fixed order', () => {
    const text = assembleRules([
      { category: 'forbid', text: 'Не обещай скидку.' },
      { category: 'business', text: 'Ставим двери в Алматы с 2015 года.' },
      { category: 'tone', text: 'Коротко, на «вы».' },
    ]);
    expect(text).toBe(
      'О компании\n- Ставим двери в Алматы с 2015 года.\n\n' +
      'Как говорить\n- Коротко, на «вы».\n\n' +
      'Чего не делать\n- Не обещай скидку.',
    );
  });

  it('skips a heading with no rules under it', () => {
    expect(assembleRules([{ category: 'tone', text: 'На «вы».' }]))
      .toBe('Как говорить\n- На «вы».');
  });

  it('keeps the order rules were given in inside a category', () => {
    const text = assembleRules([
      { category: 'order', text: 'Сначала район.' },
      { category: 'order', text: 'Потом сроки.' },
    ]);
    expect(text).toBe('О чём спрашивать\n- Сначала район.\n- Потом сроки.');
  });

  it('is empty for no rules, exactly as an empty field was', () => {
    expect(assembleRules([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ai-rules.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `rules.ts`**

```ts
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentRules } from '../../db/schema.js';

export type RuleCategory = 'business' | 'tone' | 'order' | 'forbid';

export interface AgentRule {
  category: RuleCategory;
  text: string;
}

/**
 * The four groups, in the order the prompt shows them, with the words the agent reads.
 *
 * Order is fixed rather than data: it goes from what we are, through how we sound, to what we
 * must not do — and a rule that forbids something is worth the most when it is read last.
 */
const GROUPS: readonly { category: RuleCategory; heading: string }[] = [
  { category: 'business', heading: 'О компании' },
  { category: 'tone', heading: 'Как говорить' },
  { category: 'order', heading: 'О чём спрашивать' },
  { category: 'forbid', heading: 'Чего не делать' },
];

/**
 * The rules as one string, which is what the prompt has always carried.
 *
 * One string rather than a new prompt section, because the number guard verifies a number
 * against «the instructions» and that check must go on reading exactly what the model was
 * shown. A second shape here would be a second place for the two to drift apart.
 */
export function assembleRules(rules: AgentRule[]): string {
  return GROUPS.map(({ category, heading }) => {
    const lines = rules.filter((rule) => rule.category === category);
    return lines.length === 0 ? '' : `${heading}\n${lines.map((r) => `- ${r.text}`).join('\n')}`;
  })
    .filter((block) => block !== '')
    .join('\n\n');
}

/** The enabled rules of one agent, in the order the owner arranged them. */
export async function loadRules(db: Db, agentId: string): Promise<AgentRule[]> {
  const rows = await db
    .select({ category: agentRules.category, text: agentRules.text })
    .from(agentRules)
    .where(and(eq(agentRules.agentId, agentId), eq(agentRules.enabled, true)))
    .orderBy(asc(agentRules.category), asc(agentRules.position));
  return rows as AgentRule[];
}
```

- [ ] **Step 4: Feed it to the turn**

In `server/src/lib/ai/turn.ts`, where the agent row is read, call `loadRules` and pass `assembleRules(rules)` as `PromptAgent.instructions`. `prompt.ts` is untouched except its comment on `instructionsSection`, which gains a sentence saying the string arrives assembled from rules and why the guard still reads it.

Update every fixture that set `instructions` on an agent to insert `agentRules` rows instead — `ai-prompt.test.ts`, `ai-turn.test.ts`, `ai-inbound.test.ts`, `agents-routes.test.ts`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. In particular `ai-turn.test.ts`'s number-guard cases must still pass: a number that appears in a rule is allowed, one that appears nowhere is not.

- [ ] **Step 6: Commit**

```bash
git add server/src server/test
git commit -m "Assemble the agent's instructions from its rules"
```

---

### Task 3: Rules routes

**Files:**
- Create: `server/src/api/rules.ts`
- Modify: `server/src/api/server.ts` (register)
- Test: `server/test/rules-api.test.ts`

**Interfaces:**
- Consumes: `requireAgent`, `requireOwner` — the guards `server/src/api/knowledge.ts` already uses for its source routes.
- Produces: `GET|POST /api/agents/:agentId/rules`, `PATCH|DELETE /api/agents/:agentId/rules/:ruleId`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/rules-api.test.ts — helpers copied from knowledge-api.test.ts
it('creates a rule at the end of its category', async () => {
  await post({ category: 'tone', text: 'На «вы».' });
  const second = await post({ category: 'tone', text: 'Без смайликов.' });
  expect(second.json().position).toBe(1);
});

it('refuses an unknown category and text over the limit', async () => {
  expect((await post({ category: 'банан', text: 'Раз.' })).statusCode).toBe(400);
  expect((await post({ category: 'tone', text: 'а'.repeat(501) })).statusCode).toBe(400);
});

it('switches a rule off without deleting it', async () => {
  const rule = (await post({ category: 'forbid', text: 'Не обещай скидку.' })).json();
  const res = await app.inject({ method: 'PATCH', url: `${rules()}/${rule.id}`, cookies: jar,
    payload: { enabled: false } });
  expect(res.json().enabled).toBe(false);
});

it('reorders inside a category', async () => {
  const a = (await post({ category: 'order', text: 'Сначала район.' })).json();
  const b = (await post({ category: 'order', text: 'Потом сроки.' })).json();
  await app.inject({ method: 'PATCH', url: `${rules()}/${b.id}`, cookies: jar, payload: { position: 0 } });
  const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
  expect(list.map((r: { id: string }) => r.id)).toEqual([b.id, a.id]);
});

it('refuses a member every rules route', async () => {
  for (const call of [
    { method: 'GET' as const, url: rules() },
    { method: 'POST' as const, url: rules(), payload: { category: 'tone', text: 'На «вы».' } },
  ]) {
    expect((await app.inject({ ...call, cookies: memberJar })).statusCode).toBe(403);
  }
});

it('refuses a rule of another agent with 404', async () => {
  const rule = (await post({ category: 'tone', text: 'На «вы».' })).json();
  const other = await createAccountWithOwner(db, {
    company: 'Другая', email: 'other@example.com', password: PASSWORD });
  const res = await app.inject({ method: 'PATCH', cookies: await login('other@example.com'),
    url: `/api/agents/${other.agentId}/rules/${rule.id}`, payload: { enabled: false } });
  expect(res.statusCode).toBe(404);
  expect(res.json().message).toBe('Правило не найдено');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rules-api.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the routes**

```ts
const CATEGORIES = ['business', 'tone', 'order', 'forbid'] as const;
const RULE_MAX = 500;

const createRule = z.object({
  category: z.enum(CATEGORIES),
  text: z.string().trim().min(1).max(RULE_MAX),
  // Set only when the owner insisted past the fact check; the coach route passes it.
  warning: z.string().max(200).nullish(),
});

const updateRule = z.object({
  category: z.enum(CATEGORIES).optional(),
  text: z.string().trim().min(1).max(RULE_MAX).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});
```

`POST` puts a rule at `max(position) + 1` inside its category. `PATCH` with a `position` shifts the others in that category to close the gap and open the new one, in one transaction — a list where two rules share a position renders in an order nobody chose. Every route reaches a rule through `agentId` and answers `404` with `'Правило не найдено'` otherwise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rules-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api server/test/rules-api.test.ts
git commit -m "Serve the rules list"
```

---

