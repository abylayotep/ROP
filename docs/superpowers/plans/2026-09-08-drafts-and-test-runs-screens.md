# Drafts and Test Runs — Part 3: judging and applying

> Part of [the drafts plan](2026-09-08-drafts-and-test-runs.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-drafts-and-test-runs-design.md](../specs/2026-09-08-drafts-and-test-runs-design.md)

---

### Task 7: The annotation

**Files:**
- Create: `server/src/lib/drafts/annotate.ts`
- Modify: `server/src/api/drafts.ts` (call it after the results are in)
- Test: `server/test/draft-annotate.test.ts`

**Interfaces:**
- Produces:
  - `export const VERDICT_SCHEMA` — zod for `{ verdict: 'better' | 'worse' | 'same'; reason: string }`
  - `export function buildVerdictMessages(input: VerdictInput): ChatMessage[]` where `VerdictInput = { expectation: string | null; question: string; before: string | null; after: string | null }`
  - `export async function annotate(deps, input): Promise<{ verdict: string; reason: string; cost: string } | null>` — null when the call failed.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-annotate.test.ts
it('shows the expectation, the question and both answers', () => {
  const system = buildVerdictMessages({
    expectation: 'не должен обещать скидку',
    question: 'дадите скидку?',
    before: 'Дам 10%.',
    after: 'Про скидки уточню у коллеги.',
  }).map((m) => m.content).join('\n');
  expect(system).toContain('не должен обещать скидку');
  expect(system).toContain('Дам 10%.');
  expect(system).toContain('Про скидки уточню у коллеги.');
});

it('says there was no previous answer rather than showing an empty one', () => {
  const text = buildVerdictMessages({ expectation: null, question: 'привет',
    before: null, after: 'Здравствуйте.' }).map((m) => m.content).join('\n');
  expect(text).toContain('раньше ответа не было');
});

it('refuses a verdict outside the three words', () => {
  expect(VERDICT_SCHEMA.safeParse({ verdict: 'отлично', reason: '' }).success).toBe(false);
});

it('returns null when the model call fails, without throwing', async () => {
  model.fail(new Error('timeout'));
  expect(await annotate(deps, { expectation: null, question: 'привет', before: null, after: 'Здравствуйте.' }))
    .toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/draft-annotate.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write it and call it**

The prompt is Russian and asks one thing: given what the owner expected, the customer's
question, and the two answers, is the new one better, worse or no different, and why in one
sentence. It is told explicitly that it is advising a person who will decide, not deciding.

In `server/src/api/drafts.ts`, annotate each result after both sides are in. A failed annotation
leaves `verdict` and `verdictReason` null and the run `done` — the run is the expensive part and
losing it to a hint that did not arrive would be absurd. Add the annotation cost to the run's.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-annotate.test.ts test/draft-run-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test/draft-annotate.test.ts
git commit -m "Let the model advise on a run without deciding it"
```

---

### Task 8: Applying and discarding

**Files:**
- Modify: `server/src/api/drafts.ts`
- Test: `server/test/draft-apply-api.test.ts`

**Interfaces:**
- Consumes: `applyOps`, `staleOps`, `bumpConfigVersion`.
- Produces: `POST /api/agents/:agentId/drafts/:draftId/apply`, `POST …/discard`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-apply-api.test.ts
it('refuses a draft that has never been run', async () => {
  const draft = await openDraft();
  const res = await apply(draft.id);
  expect(res.statusCode).toBe(409);
  expect(res.json().message).toBe('Черновик не прогнан — сначала проверьте его');
});

it('refuses a draft run before the store changed', async () => {
  const draft = await openDraft();
  await runOver(draft, [await addCase('сколько стоит доставка')]);
  await addRule({ category: 'tone', text: 'На «вы».' });
  const res = await apply(draft.id);
  expect(res.statusCode).toBe(409);
  expect(res.json().message).toBe('База изменилась после проверки — прогоните черновик заново');
});

it('refuses a draft whose note moved underneath it', async () => {
  const note = await addNote('Доставка', '1500 ₸.');
  const draft = await openDraft([{ op: 'note_update', noteId: note.id, body: '1600 ₸.' }]);
  await runOver(draft, [await addCase('сколько стоит доставка')]);
  // Editing the note bumps the version too, so the message must name the note, not the version.
  await editNote(note.id, '1700 ₸.');
  const res = await apply(draft.id);
  expect(res.json().message).toContain('Доставка');
});

it('applies, bumps the version and marks the draft applied', async () => {
  const draft = await openDraft([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
  await runOver(draft, [await addCase('дадите скидку?')]);
  const before = await configVersion();
  expect((await apply(draft.id)).statusCode).toBe(200);
  expect(await configVersion()).toBe(before + 1);
  const [stored] = await db.select().from(kbDrafts).where(eq(kbDrafts.id, draft.id));
  expect(stored!.status).toBe('applied');
  expect(await db.select().from(agentRules)).toHaveLength(1);
});

it('refuses to apply an applied draft a second time', async () => {
  const draft = await openDraft([{ op: 'rule_create', category: 'tone', text: 'На «вы».' }]);
  await runOver(draft, [await addCase('здравствуйте')]);
  await apply(draft.id);
  const again = await apply(draft.id);
  expect(again.statusCode).toBe(409);
  expect(await db.select().from(agentRules)).toHaveLength(1);
});

it('discards without writing anything', async () => {
  const draft = await openDraft([{ op: 'rule_create', category: 'tone', text: 'На «вы».' }]);
  const before = await configVersion();
  const res = await app.inject({ method: 'POST', url: `${drafts()}/${draft.id}/discard`, cookies: jar });
  expect(res.statusCode).toBe(200);
  expect(await db.select().from(agentRules)).toEqual([]);
  expect(await configVersion()).toBe(before);
});

it('applies over a red verdict, because the owner decides', async () => {
  const draft = await openDraft([{ op: 'rule_create', category: 'tone', text: 'На «ты».' }]);
  await runOver(draft, [await addCase('здравствуйте')], { verdict: 'worse' });
  expect((await apply(draft.id)).statusCode).toBe(200);
});

it('refuses a member', async () => {
  const draft = await openDraft();
  expect((await app.inject({ method: 'POST', cookies: memberJar,
    url: `${drafts()}/${draft.id}/apply` })).statusCode).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draft-apply-api.test.ts`
Expected: FAIL — 404 on apply.

- [ ] **Step 3: Write the routes**

Apply, in one transaction and in this order: refuse a draft not `open`; refuse one with no
`done` run at the agent's current `configVersion`, naming which of the two is wrong; call
`staleOps` and refuse with the names it returns; `applyOps`; `bumpConfigVersion`; set `applied`
and `appliedAt`. The messages are Russian and say what to do next, because the owner meets them
at the moment they expected the change to land.

Discard sets `discarded` and touches nothing else.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-apply-api.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/drafts.ts server/test/draft-apply-api.test.ts
git commit -m "Apply a draft only when what was tested is what lands"
```

---

### Task 9: The case set

**Files:**
- Create: `server/src/api/test-cases.ts`
- Modify: `server/src/api/server.ts` (register)
- Test: `server/test/test-cases-api.test.ts`

**Interfaces:**
- Produces: `GET|POST /api/agents/:agentId/test-cases`, `PATCH|DELETE …/:caseId`, `POST …/from-dialog`, `POST /api/agents/:agentId/drafts/:draftId/suggest-cases`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/test-cases-api.test.ts
it('creates a case from the customer messages and an expectation', async () => {
  const res = await post({ title: 'Про скидку', messages: ['дадите скидку?'],
    expectation: 'не должен обещать скидку' });
  expect(res.json().origin).toBe('manual');
});

it('refuses eleven messages and a message over the length limit', async () => {
  expect((await post({ title: 'Много', messages: Array(11).fill('раз') })).statusCode).toBe(400);
  expect((await post({ title: 'Длинно', messages: ['а'.repeat(4001)] })).statusCode).toBe(400);
});

it('pulls the customer side out of a dialog and nothing else', async () => {
  const { conversationId } = await dialogWith([
    { author: 'client', body: 'здравствуйте' },
    { author: 'agent', body: 'Здравствуйте! Какие двери нужны?' },
    { author: 'client', body: 'входные' },
  ]);
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `${cases()}/from-dialog`, payload: { conversationId } });
  expect(res.json().messages).toEqual(['здравствуйте', 'входные']);
  expect(res.json().origin).toBe('dialog');
});

it('takes at most ten messages out of a long dialog', async () => {
  const { conversationId } = await dialogWith(
    Array.from({ length: 14 }, (_, i) => ({ author: 'client' as const, body: `реплика ${i}` })));
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `${cases()}/from-dialog`, payload: { conversationId } });
  expect(res.json().messages).toHaveLength(10);
  expect(res.json().messages[9]).toBe('реплика 13');
});
it('suggests cases without saving any of them', async () => {
  model.reply({ cases: [{ title: 'Доставка в Астану', messages: ['везёте в Астану?'] }] });
  const draft = await openDraft();
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `${drafts()}/${draft.id}/suggest-cases` });
  expect(res.json().cases).toHaveLength(1);
  expect(await db.select().from(testCases)).toEqual([]);
});

it('switches a case off without deleting it', async () => {
  const kase = (await post({ title: 'Про скидку', messages: ['дадите скидку?'] })).json();
  const res = await app.inject({ method: 'PATCH', url: `${cases()}/${kase.id}`, cookies: jar,
    payload: { enabled: false } });
  expect(res.json().enabled).toBe(false);
  expect(await db.select().from(testCases)).toHaveLength(1);
});

it('refuses a member', async () => {
  expect((await app.inject({ method: 'GET', url: cases(), cookies: memberJar })).statusCode).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/test-cases-api.test.ts`
Expected: FAIL — 404 on the case routes.

- [ ] **Step 3: Write the routes**

Validation: `title` up to 200, one to ten `messages` of up to 4000 each, `expectation` up to 500.
`from-dialog` reads the conversation's inbound messages, newest ten, oldest first, and titles the
case by the first of them. `suggest-cases` asks the model for five to ten customer questions
aimed at what the draft changes and returns them **unsaved** — the screen decides what is kept,
because a set that grows by itself is a set nobody trusts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/test-cases-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api server/test/test-cases-api.test.ts
git commit -m "Keep, pull and suggest the conversations a draft is tested on"
```

---

### Task 10: The contract

**Files:**
- Modify: `packages/contract/index.ts`

**Interfaces:**
- Produces: `DraftOp`, `KbDraft`, `TestCase`, `TestRun`, `TestComparison`. `CoachMessage.draftId` is already declared by the coaching plan.

- [ ] **Step 1: Write the types**

```ts
export type DraftOp =
  | { op: 'note_create'; path: string; body: string }
  | { op: 'note_update'; noteId: string; body: string }
  | { op: 'rule_create'; category: RuleCategory; text: string; warning?: string | null }
  | { op: 'rule_update'; ruleId: string; text?: string; enabled?: boolean };

/** A change waiting to be proven. It is applied only after a run at the current version. */
export interface KbDraft {
  id: string;
  title: string;
  origin: 'coach' | 'manual';
  status: 'open' | 'applied' | 'discarded';
  ops: DraftOp[];
  createdAt: string;
  appliedAt: string | null;
}

export interface TestCase {
  id: string;
  title: string;
  /** The customer's side only. The agent's replies are what is being tested. */
  messages: string[];
  expectation: string | null;
  origin: 'manual' | 'dialog' | 'generated';
  conversationId: string | null;
  enabled: boolean;
  updatedAt: string;
}

/** One row of the «было — стало» table. `before` is null when the case is new to the set. */
export interface TestComparison {
  caseId: string;
  title: string;
  expectation: string | null;
  before: string | null;
  after: string | null;
  usedSections: string[];
  handoff: boolean;
  handoffReason: string | null;
  /** The model's hint. It gates nothing — the owner presses the button. */
  verdict: 'better' | 'worse' | 'same' | null;
  verdictReason: string | null;
}

export interface TestRun {
  id: string;
  draftId: string | null;
  configVersion: number;
  model: string;
  status: 'running' | 'done' | 'failed';
  /** In US dollars, as OpenRouter reported it. */
  cost: string;
  results: TestComparison[];
  startedAt: string;
  finishedAt: string | null;
}
```

- [ ] **Step 2: Typecheck**

Run from `server/`: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/contract/index.ts
git commit -m "Name drafts, cases and comparisons in the contract"
```

---

### Task 11: The draft screen and the case set

**Files:**
- Create: `rakurs/src/screens/DraftScreen.tsx`, `rakurs/src/components/drafts/OpDiff.tsx`, `rakurs/src/components/drafts/RunTable.tsx`, `rakurs/src/components/drafts/CaseList.tsx`, `rakurs/src/components/drafts/cost.ts`
- Modify: `rakurs/src/screens/CoachScreen.tsx` (enable «В черновик»), `rakurs/src/screens/DialogsScreen.tsx` («В проверки»), `rakurs/src/api/index.ts`
- Test: `rakurs/src/components/drafts/cost.test.ts`

**Interfaces:**
- Produces: `export function describeRun(cases: TestCase[], baselines: Set<string>): string` — the Russian sentence shown above the run button.

- [ ] **Step 1: Write the failing test**

```ts
// rakurs/src/components/drafts/cost.test.ts
import { describe, expect, it } from 'vitest';
import { describeRun } from './cost.js';

const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }) as never);

describe('describeRun', () => {
  it('counts both sides when nothing is cached', () => {
    expect(describeRun(cases(3), new Set()))
      .toBe('3 проверки: 6 вызовов модели плюс 3 сравнения');
  });

  it('says the baselines are taken from a previous run', () => {
    expect(describeRun(cases(3), new Set(['0', '1', '2'])))
      .toBe('3 проверки: 3 вызова модели (прежние ответы взяты из прошлого прогона) плюс 3 сравнения');
  });

  it('counts a mixed set', () => {
    expect(describeRun(cases(3), new Set(['0'])))
      .toBe('3 проверки: 5 вызовов модели плюс 3 сравнения');
  });

  it('declines the Russian noun for one and for five', () => {
    expect(describeRun(cases(1), new Set())).toContain('1 проверка');
    expect(describeRun(cases(5), new Set())).toContain('5 проверок');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `rakurs/`: `npx vitest run src/components/drafts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the screen**

`DraftScreen` shows, top to bottom: `OpDiff` — for a note, the old body against the new, line by
line; for a rule, its category and text. Then the case checkboxes, defaulting to every enabled
case, with «Придумать проверки» adding suggestions as unticked rows nobody saved. Then
`describeRun`'s sentence and the run button. Then `RunTable`: case, «было», «стало», the sections
used, the handoff, and the verdict with its one line, a row expanding to both replies in full.
Then «Применить» and «Отбросить».

«Применить» is enabled whenever a run at the current version exists — a red verdict does not
disable it, and a stale draft explains itself in words from the server rather than greying out
silently.

A «Проверки» tab holds the set: list, add, edit, enable, delete. `CoachScreen`'s «В черновик»
now navigates here. `DialogsScreen` gains «В проверки» beside «Так нельзя».

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run src/components/drafts` then `npm run build`
Expected: PASS, then a clean build.

- [ ] **Step 5: Commit**

```bash
git add rakurs/src
git commit -m "Read the run before pushing the change"
```

---

### Task 12: The owner's documentation

**Files:**
- Create: `docs/drafts-and-checks.md`
- Modify: `docs/agent-coaching.md`, `docs/ai-agent.md` §5

- [ ] **Step 1: Write `docs/drafts-and-checks.md`**

Russian, the voice of the existing docs, under 500 lines. It must cover:

- what a draft is: a change that exists nowhere until it is proven, one draft per change;
- the set of checks — writing one by hand, pulling one out of a dialog, asking for suggestions,
  and why a check is switched off rather than deleted;
- what a run is: the agent answering the way it would answer, on a store that is thrown away
  afterwards, so nothing reaches a customer and nothing moves in the cabinet;
- «было — стало», and that the model's «лучше/хуже» is advice — the owner presses the button,
  and «хуже» is sometimes exactly what was wanted;
- money, plainly: every cell is a real call, the previous answers are reused where they can be,
  and applying a change makes the next run pay for its baselines again — which is correct,
  because the agent has changed;
- why applying can be refused, in both its forms, and what to do about each;
- what goes wrong, as a table.

- [ ] **Step 2: Point the other two at it**

`docs/agent-coaching.md`: the section on accepting a proposal now ends at «В черновик» and links
here. `docs/ai-agent.md` §5 says the sandbox is one message and the checks are a set, and links
here.

- [ ] **Step 3: Check the line counts**

Run: `wc -l docs/*.md`
Expected: every file under 500.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "Describe drafts and checks the way an owner meets them"
```
