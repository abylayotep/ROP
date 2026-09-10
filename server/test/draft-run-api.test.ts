/**
 * The route that ties the drafts pipeline together: `POST …/coach/messages/:id/draft` turns a
 * checked coach proposal into a draft, and `POST …/drafts/:draftId/runs` plays it against real
 * conversations without ever touching the store the agent actually answers from.
 *
 * This is also `agent-coaching.md`'s missing piece: the coaching chat's «В черновик» button has
 * had nothing to call until this file exists.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileOrphanedRuns } from '../src/api/drafts.js';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agentRules,
  agents,
  aiReplies,
  coachMessages,
  contacts,
  conversations,
  kbChunks,
  kbDrafts,
  kbLinks,
  kbNotes,
  leadValues,
  messages,
  notes,
  stageTransitions,
  testCases,
  testResults,
  testRuns,
  whatsappNumbers,
} from '../src/db/schema.js';
import type { CoachProposal } from '../src/lib/ai/coach.js';
import type { CompletionInput, ModelClient } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import type { DraftOp } from '../src/lib/drafts/ops.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-draft-run-api-0123456789';

/**
 * A model that answers the same scripted reply on every call, and can be made to hang until
 * released — the two things this file's tests need, neither of which the per-turn queue in
 * `draft-replay.test.ts`'s `scriptedModel` or `coach-api.test.ts`'s `fakeCoachModel` offers on
 * its own. Every call cites every record it was shown, the same reason `draft-replay.test.ts`
 * does it, so a test never has to hand-compute a chunk id of its own.
 */
interface FakeModel extends ModelClient {
  calls: CompletionInput[];
  replyAlways(payload: { text: string; handoff?: { reason: string } | null }): void;
  /**
   * Makes the reply say so whenever a call's own prompt contains `marker` — the only way a
   * test here can tell «стало» from «было» without hand-computing a chunk id: a case's draft
   * ops are applied fresh inside `replayCase`'s own transaction before the model is ever
   * called, so a distinctive note only the draft carries shows up in the prompt on the
   * «стало» call and nowhere else. See the swap-test finding this exists to close.
   */
  markDistinctive(marker: string): void;
  hang(): void;
  release(): void;
}

function fakeModel(): FakeModel {
  const calls: CompletionInput[] = [];
  let script = { text: '', handoff: null as { reason: string } | null };
  let distinctive: string | null = null;
  let gate: Promise<void> | null = null;
  let open = () => {};

  return {
    calls,
    replyAlways(payload) {
      script = { text: payload.text, handoff: payload.handoff ?? null };
    },
    markDistinctive(marker) {
      distinctive = marker;
    },
    hang() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = null;
    },
    async complete(input) {
      calls.push(input);
      if (gate) await gate;
      const prompt = input.messages.map((m) => m.content).join('\n');
      const usedItemIds = [...prompt.matchAll(/<запись id="([^"]+)"/g)].map((m) => m[1]);
      const seen = distinctive !== null && prompt.includes(distinctive);
      return {
        text: JSON.stringify({
          reply: seen ? `${script.text} ${distinctive}` : script.text,
          stageId: null,
          fields: {},
          handoff: script.handoff,
          usedItemIds,
        }),
        promptTokens: 100,
        completionTokens: 20,
        cost: '0.00010000',
      };
    },
  };
}

let app: FastifyInstance;
let db: Db;
let agentId: string;
let jar: Record<string, string>;
let memberJar: Record<string, string>;
let model: FakeModel;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const drafts = () => `/api/agents/${agentId}/drafts`;

async function coachProposed(proposal: CoachProposal, contextAt?: Date) {
  const [row] = await db
    .insert(coachMessages)
    .values({ agentId, role: 'model', text: 'Предложение.', proposal, status: 'pending', contextAt })
    .returning();
  return row!;
}

async function openDraft(ops: DraftOp[] = []) {
  const [row] = await db
    .insert(kbDrafts)
    .values({ agentId, title: 'Черновик', origin: 'coach', status: 'open', ops, base: {} })
    .returning();
  return row!;
}

async function addCase(text: string, enabled = true) {
  const [row] = await db
    .insert(testCases)
    .values({ agentId, title: text, messages: [text], origin: 'manual', enabled })
    .returning();
  return row!;
}

function run(draftId: string, caseIds: string[], asMember = false) {
  return app.inject({
    method: 'POST',
    cookies: asMember ? memberJar : jar,
    url: `${drafts()}/${draftId}/runs`,
    payload: { caseIds },
  });
}

/**
 * Polls the database directly for a run's own `test_runs.status` to leave `'running'` — the
 * route now answers before the replay it started is done (see `api/drafts.ts`'s own "The run
 * is asynchronous"), so every test that cares how a run actually turned out has to wait for it
 * itself, the same way `capi-queue.test.ts`'s own `eventually` waits for the detached work
 * that file tests — see that file's comment on why its own budget had to be raised once
 * already. Waiting here, inside the test, rather than trusting a coincidence of timing, is
 * also what keeps `afterEach`'s `app.close()` from racing work this test itself started: every
 * test below that runs something calls this before it ends.
 */
async function waitForRun(runId: string): Promise<typeof testRuns.$inferSelect> {
  for (let tries = 0; tries < 300; tries += 1) {
    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
    if (row && row.status !== 'running') return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run never left `running`');
}

/**
 * Every table any turn — real or replayed — could write, agent-scoped. Wider than
 * `draft-replay.test.ts`'s own snapshot on purpose: that file's is a claim about `replayCase`
 * alone and deliberately leaves `ai_replies`, `lead_values`, the handoff `notes` and
 * `stage_transitions` to `dryRun`'s own test, per its header comment. This route is the actual
 * integration point an owner's data goes through, so this is the one place that promise is
 * checked end to end rather than assumed from another file's word.
 */
async function snapshot(database: Db, forAgentId: string) {
  return {
    agent: await database.select().from(agents).where(eq(agents.id, forAgentId)),
    notes: await database.select().from(kbNotes).where(eq(kbNotes.agentId, forAgentId)),
    chunks: await database.select().from(kbChunks).where(eq(kbChunks.agentId, forAgentId)),
    links: await database.select().from(kbLinks).where(eq(kbLinks.agentId, forAgentId)),
    rules: await database.select().from(agentRules).where(eq(agentRules.agentId, forAgentId)),
    contacts: await database.select().from(contacts).where(eq(contacts.agentId, forAgentId)),
    conversations: await database
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, forAgentId)),
    messages: await database
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        direction: messages.direction,
        author: messages.author,
        body: messages.body,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.agentId, forAgentId)),
    aiReplies: await database.select().from(aiReplies).where(eq(aiReplies.agentId, forAgentId)),
    stageTransitions: await database
      .select()
      .from(stageTransitions)
      .where(eq(stageTransitions.agentId, forAgentId)),
    leadValues: await database
      .select({
        conversationId: leadValues.conversationId,
        fieldId: leadValues.fieldId,
        value: leadValues.value,
      })
      .from(leadValues)
      .innerJoin(conversations, eq(conversations.id, leadValues.conversationId))
      .where(eq(conversations.agentId, forAgentId)),
    handoffNotes: await database
      .select({ id: notes.id, conversationId: notes.conversationId, body: notes.body })
      .from(notes)
      .innerJoin(conversations, eq(conversations.id, notes.conversationId))
      .where(eq(conversations.agentId, forAgentId)),
  };
}

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  // Minted here rather than read back — the OpenRouter key is sealed against this id before
  // the row exists, the same reason every other draft/coach test does it this way.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Сафина',
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, keyAad(agentId)),
  });

  // A run needs somewhere to invent its fake conversation on, exactly as the sandbox does.
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: randomUUID(),
    wabaId: randomUUID(),
    displayPhone: '+7 700 000 00 00',
    accessToken: encryptSecret('unused', key, randomUUID()),
  });

  model = fakeModel();
  app = buildServer(env, db, { graph: fakeGraph(), model });
  await app.ready();
  jar = await login();
  memberJar = await login('member@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('turning a coach proposal into a draft', () => {
  it('turns a coach proposal into a draft holding one operation', async () => {
    const message = await coachProposed({ kind: 'rule', category: 'forbid', text: 'Не обещай скидку.' });

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ops).toEqual([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
    const [stored] = await db.select().from(coachMessages).where(eq(coachMessages.id, message.id));
    expect(stored!.status).toBe('drafted');
    expect(stored!.draftId).toBe(res.json().id);
  });

  it('maps every proposal kind onto its own op', async () => {
    const rule = await db.insert(agentRules).values({
      agentId,
      category: 'tone',
      text: 'Обращайся на «вы».',
      position: 0,
      origin: 'manual',
    }).returning();
    const note = await db.insert(kbNotes).values({ agentId, path: 'Доставка.md', title: 'Доставка' }).returning();

    const cases: { proposal: CoachProposal; op: DraftOp }[] = [
      {
        proposal: { kind: 'rule_edit', ruleId: rule[0]!.id, text: 'Обращайся на «Вы».', enabled: false },
        op: { op: 'rule_update', ruleId: rule[0]!.id, text: 'Обращайся на «Вы».', enabled: false },
      },
      {
        proposal: { kind: 'note', path: 'Гарантия.md', body: '2 года.' },
        op: { op: 'note_create', path: 'Гарантия.md', body: '2 года.' },
      },
      {
        proposal: { kind: 'note_edit', noteId: note[0]!.id, body: '1600 ₸.' },
        op: { op: 'note_update', noteId: note[0]!.id, body: '1600 ₸.' },
      },
    ];

    for (const { proposal, op } of cases) {
      const message = await coachProposed(proposal);
      const res = await app.inject({
        method: 'POST',
        cookies: jar,
        url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ops).toEqual([op]);
    }
  });

  it('refuses a message with no proposal', async () => {
    const [message] = await db
      .insert(coachMessages)
      .values({ agentId, role: 'model', text: 'Понял.', proposal: null, status: 'pending' })
      .returning();

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message!.id}/draft`,
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a proposal that was already drafted', async () => {
    const message = await coachProposed({ kind: 'rule', category: 'forbid', text: 'Не обещай скидку.' });
    const first = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a member', async () => {
    const message = await coachProposed({ kind: 'rule', category: 'forbid', text: 'Не обещай скидку.' });
    const res = await app.inject({
      method: 'POST',
      cookies: memberJar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });
    expect(res.statusCode).toBe(403);
  });

  // The coach's proposal is written against the text it saw. If the owner edits that same row
  // themselves before clicking «В черновик», the draft's `base` — taken only now, when the
  // draft is made — would record the *post-edit* timestamp and see nothing stale: the owner's
  // own edit would silently be overwritten later by a body the coach wrote against older text.
  // `config_version`'s catch-all does not reach this, because the edit already happened before
  // the draft (and so its version check) exists at all.
  it('refuses to draft a note the owner edited after the coach proposed against it', async () => {
    const [note] = await db
      .insert(kbNotes)
      .values({ agentId, path: 'Доставка.md', title: 'Доставка', body: 'Старая цена.' })
      .returning();
    const message = await coachProposed({ kind: 'note_edit', noteId: note!.id, body: 'Предложение коуча.' });

    // The owner's own edit, landing after the proposal was written. `sql\`now()\`` rather than
    // a JS `new Date()`: the route compares this row's `updated_at` against
    // `coach_messages.created_at`, both Postgres-stamped columns, and a JS-side clock is not
    // guaranteed to agree with Postgres's own to the sub-second precision this test needs.
    await db
      .update(kbNotes)
      .set({ body: 'Правка владельца.', updatedAt: sql`now()` })
      .where(eq(kbNotes.id, note!.id));

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });

    expect(res.statusCode).toBe(409);
    const [stored] = await db.select().from(coachMessages).where(eq(coachMessages.id, message.id));
    // Still pending — refused before the draft (or the status flip) was ever written.
    expect(stored!.status).toBe('pending');
  });

  // `coach_messages.created_at` is stamped when the model's reply is inserted — after up to two
  // attempts, minutes later — not when the store the proposal was written against was read. An
  // owner who edits the very row while the coach is still thinking moved it after the context
  // was actually read, even though the edit lands *before* `created_at` is ever stamped —
  // comparing against `created_at` alone, as the route used to, would have missed exactly this
  // edit and let the draft through.
  it('refuses a draft when the edit landed while the coach was still thinking, not just after it answered', async () => {
    const [note] = await db
      .insert(kbNotes)
      .values({ agentId, path: 'Доставка.md', title: 'Доставка', body: 'Старая цена.' })
      .returning();

    // Stands in for the moment the store was read, well before the model answered — `createdAt`
    // defaults to `now()` on insert below, minutes later in the real flow this simulates.
    const contextAt = new Date(Date.now() - 5_000);
    const message = await coachProposed(
      { kind: 'note_edit', noteId: note!.id, body: 'Предложение коуча.' },
      contextAt,
    );
    const [stored] = await db.select().from(coachMessages).where(eq(coachMessages.id, message.id));
    expect(stored!.createdAt.getTime()).toBeGreaterThan(contextAt.getTime());

    // Landed after `contextAt` but before `createdAt` — set explicitly rather than `now()`,
    // since by wall-clock time this line runs strictly after the message above was inserted,
    // and `now()` would land after `createdAt`, not inside the gap this test means to hit.
    const editedAt = new Date(contextAt.getTime() + 1_000);
    await db.update(kbNotes).set({ body: 'Правка владельца.', updatedAt: editedAt }).where(eq(kbNotes.id, note!.id));
    const [editedNote] = await db.select().from(kbNotes).where(eq(kbNotes.id, note!.id));
    expect(editedNote!.updatedAt.getTime()).toBeLessThan(stored!.createdAt.getTime());

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message.id}/draft`,
    });

    expect(res.statusCode).toBe(409);
  });
});

describe('running a draft over a set of cases', () => {
  // The critical property this file's whole redesign rests on: the response comes back before
  // the run it started is done, not once it is — see `api/drafts.ts`'s own "The run is
  // asynchronous" for why a route that used to await the whole replay would answer past
  // `deploy/nginx.conf`'s own 120-second `proxy_read_timeout` on a run of any real size.
  it('answers before the case results are written, not after', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });
    model.hang();

    const res = await run(draft.id, [kase.id]);

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('running');
    expect(res.json().id).toBeTruthy();
    // The one call this case needs has not even resolved yet — proof the response did not
    // wait for the work it started, not merely that the work happens to be fast.
    const rows = await db.select().from(testResults).where(eq(testResults.runId, res.json().id));
    expect(rows).toHaveLength(0);

    model.release();
    const finished = await waitForRun(res.json().id);
    expect(finished.status).toBe('done');
  });

  // `request<TestRun>` on the client (`rakurs/src/api/index.ts`) is an unchecked cast — nothing
  // there catches a response that is missing a field the contract promises. `RunTable.tsx`
  // reads `run.results.length` unguarded the instant a run is `'running'`, which is exactly the
  // state this response answers in, so `results` missing here is a `TypeError` on the very
  // first render after the click, not a type error anywhere a build would catch it. Checked
  // field by field, against `TestRun` (`@rakurs/contract`) in full, not only `results`.
  it('answers POST with every field TestRun promises, not just the ones a client happened to read', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.hang();

    const posted = await run(draft.id, [kase.id]);
    expect(posted.statusCode).toBe(200);
    const body = posted.json();

    expect(body).toMatchObject({
      draftId: draft.id,
      status: 'running',
      draftCost: '0',
      baselineCost: '0',
      results: [],
      finishedAt: null,
    });
    expect(typeof body.id).toBe('string');
    expect(typeof body.configVersion).toBe('number');
    expect(typeof body.model).toBe('string');
    expect(typeof body.startedAt).toBe('string');

    model.release();
    await waitForRun(posted.json().id);
  });

  it('runs every named case and records a result each', async () => {
    const draft = await openDraft();
    const one = await addCase('сколько стоит доставка');
    const two = await addCase('есть ли рассрочка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [one.id, two.id]);
    expect(posted.statusCode).toBe(200);
    expect(posted.json().status).toBe('running');

    const finished = await waitForRun(posted.json().id);
    expect(finished.status).toBe('done');

    const rows = await db.select().from(testResults).where(eq(testResults.runId, posted.json().id));
    expect(rows).toHaveLength(2);
  });

  it('spends nothing on a baseline it already has', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const first = await run(draft.id, [kase.id]);
    await waitForRun(first.json().id);
    const spent = model.calls.length;

    const second = await openDraft();
    const posted = await run(second.id, [kase.id]);
    await waitForRun(posted.json().id);

    // Two calls for the draft side — the reply itself, and the annotation comparing it
    // against the baseline. The baseline itself is read, not re-run.
    expect(model.calls.length).toBe(spent + 2);
  });

  // This file's own fake model always answers the annotation call with a turn-shaped reply
  // (`{reply, stageId, ...}`, never `{verdict, reason}`), so it never parses as a verdict — see
  // `draft-annotate.test.ts` for that behaviour in isolation. Before `annotate` carried its
  // cost back on a parse failure, that call's `0.0001` simply vanished from `draftCost`: paid
  // for, but not on the total anyone ever saw.
  it("counts the annotation's cost even though its reply never parses as a verdict", async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    await waitForRun(posted.json().id);

    const res = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${draft.id}/runs/${posted.json().id}`,
    });
    expect(res.json().results[0]!.verdict).toBeNull();
    // «Стало» plus the annotation — two real calls at this fake model's fixed cost each, not
    // just the reply's own.
    expect(res.json().draftCost).toBe('0.00020000');
  });

  // An empty `caseIds` used to insert a `done` run at the agent's current `config_version` —
  // literally satisfying the apply gate the spec describes without a single case ever having
  // been checked. Refused outright instead: there is no such thing as a run that proves
  // nothing — and refused synchronously, before a run is ever admitted, so nothing here waits.
  it('refuses an empty case list', async () => {
    const draft = await openDraft();

    const res = await run(draft.id, []);

    expect(res.statusCode).toBe(400);
    const [row] = await db.select().from(testRuns).where(eq(testRuns.agentId, agentId));
    expect(row).toBeUndefined();
  });

  // The spec says a disabled case stays in the set but is not run. A stale list from an open
  // tab must not pay for a case the owner has since switched off.
  it('does not run a case the owner has switched off, even if asked to', async () => {
    const draft = await openDraft();
    const on = await addCase('сколько стоит доставка');
    const off = await addCase('вопрос про акцию', false);
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [on.id, off.id]);
    expect(posted.statusCode).toBe(200);
    await waitForRun(posted.json().id);

    const rows = await db.select().from(testResults).where(eq(testResults.runId, posted.json().id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caseId).toBe(on.id);
  });

  it('refuses a run whose every named case is disabled', async () => {
    const draft = await openDraft();
    const off = await addCase('вопрос про акцию', false);

    const res = await run(draft.id, [off.id]);

    expect(res.statusCode).toBe(400);
  });

  // The property the whole feature rests on: swap `before` and `after` and every other test in
  // this file still passes, while the owner is shown an inverted comparison and a
  // draft-contaminated row is written as the reusable baseline for every future run. A note
  // only the draft's own ops add is the tracer: it can show up in «стало», must never show up
  // in «было», and must never land in the baseline row the *next* run would reuse.
  it('shows a draft\'s own note in «стало», never in «было» or in the stored baseline', async () => {
    const distinctive = `особая-цена-${randomUUID()}`;
    const draft = await openDraft([{ op: 'note_create', path: 'Особое.md', body: distinctive }]);
    const kase = await addCase('расскажи что-нибудь особое');
    model.replyAlways({ text: 'Уточню у коллеги.' });
    model.markDistinctive(distinctive);

    const posted = await run(draft.id, [kase.id]);
    await waitForRun(posted.json().id);

    const res = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${draft.id}/runs/${posted.json().id}`,
    });
    expect(res.statusCode).toBe(200);
    const { before, after } = res.json().results[0]!;
    expect(after.reply).toContain(distinctive);
    expect(before.reply).not.toContain(distinctive);

    const [baselineRow] = await db
      .select({ reply: testResults.reply })
      .from(testResults)
      .innerJoin(testRuns, eq(testResults.runId, testRuns.id))
      .where(and(eq(testRuns.agentId, agentId), isNull(testRuns.draftId)));
    expect(baselineRow!.reply).not.toContain(distinctive);
  });

  // A baseline pass that gets through several cases before one blows up used to throw the
  // whole thing away: the run that produced it was marked `failed`, and `baselineResults` only
  // ever reuses a `done` row, so every already-paid-for baseline in it became permanently
  // unreachable. A baseline run's status describes whether its rows may be reused, not whether
  // the request that made it finished.
  it("keeps an interrupted baseline run's own good results reusable", async () => {
    const draft = await openDraft();
    const good = await addCase('сколько стоит доставка');
    // No `addCase` here on purpose: an empty `messages` array makes `replayCase` itself throw
    // (see its own guard), a real exception rather than an ordinary per-case model failure —
    // exactly the shape of thing that used to take the whole baseline run down with it.
    const [broken] = await db
      .insert(testCases)
      .values({ agentId, title: 'пустой случай', messages: [], origin: 'manual' })
      .returning();
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [good.id, broken!.id]);
    expect(posted.statusCode).toBe(200);
    // The exception now lands behind the response — see `api/drafts.ts`'s own "An error has
    // nowhere left to answer to" — so the run's own status, not the HTTP response, is what
    // says this run did not finish.
    const finished = await waitForRun(posted.json().id);
    expect(finished.status).toBe('failed');

    const [baselineRun] = await db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.agentId, agentId), isNull(testRuns.draftId)));
    expect(baselineRun!.status).toBe('done');

    const spent = model.calls.length;
    const second = await openDraft();
    const rerun = await run(second.id, [good.id]);
    await waitForRun(rerun.json().id);
    // Two calls for the second draft's own «стало» — the reply and its annotation. The good
    // case's «было» is read back, not re-run — the baseline run being `done` is what makes
    // that possible.
    expect(model.calls.length).toBe(spent + 2);
  });

  // `applyOps` (`ops.ts`) writes a `note_create` op through `saveNote`, the same path a real
  // note create goes through — and a real note already sitting at that path (created after the
  // draft was made) makes it raise Postgres's own `23505` rather than the typed
  // `MissingDraftRowError` this loop already knew how to name. Before this fix that reached
  // `runReplay`'s catch as an unlabelled error: the run still ended `failed` — nothing here
  // ever throws past that catch — but with no hint at all of what actually went wrong.
  it('fails a run gracefully when a note_create op collides with a note that already exists', async () => {
    await db.insert(kbNotes).values({ agentId, path: 'Доставка.md', title: 'Доставка' });
    const draft = await openDraft([{ op: 'note_create', path: 'Доставка.md', body: 'Новая доставка.' }]);
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    expect(posted.statusCode).toBe(200);
    const finished = await waitForRun(posted.json().id);
    expect(finished.status).toBe('failed');

    // The case's own transaction rolled back — the real note is exactly as it was, not
    // overwritten and not duplicated.
    const notes = await db.select().from(kbNotes).where(eq(kbNotes.agentId, agentId));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Доставка');
  });

  it('refuses more than twenty cases', async () => {
    const draft = await openDraft();
    const ids = await Promise.all(Array.from({ length: 21 }, (_, i) => addCase(`вопрос ${i}`)));

    const res = await run(draft.id, ids.map((c) => c.id));

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('За один прогон можно проверить не больше двадцати случаев');
  });

  // The in-flight cap is process-wide — one counter shared with the sandbox and the coach
  // (`db/turn-cap.ts`) — and has nothing to do with which draft is running. Three *different*
  // drafts run at once here on purpose: a fourth is refused because the pool is full, not
  // because of anything about its own draft — that guard is the next test's job. Each of the
  // three POSTs answers immediately now — see "The run is asynchronous" — so what this test
  // waits for is not the *requests* returning but their detached replays actually reaching the
  // model and holding a real turn-cap slot, which is the thing the fourth run's 429 depends on.
  it('refuses a fourth run in flight with 429', async () => {
    model.hang();
    const fourDrafts = await Promise.all([openDraft(), openDraft(), openDraft(), openDraft()]);
    const kase = await addCase('сколько стоит доставка');

    const posted = await Promise.all(fourDrafts.slice(0, 3).map((d) => run(d.id, [kase.id])));
    for (const res of posted) expect(res.statusCode).toBe(200);
    while (model.calls.length < 3) await new Promise((resolve) => setImmediate(resolve));

    expect((await run(fourDrafts[3]!.id, [kase.id])).statusCode).toBe(429);

    model.release();
    for (const res of posted) {
      const finished = await waitForRun(res.json().id);
      expect(finished.status).toBe('done');
    }
  });

  // Task 6's own concurrency test used to fire three simultaneous runs of *one* draft and
  // expect all three to succeed — the very shape a double click produces, and precisely what
  // must not happen: a run this expensive, with no progress shown, refuses a second run of a
  // draft that already has one in flight. The lock is held for as long as the run is actually
  // working now, not merely for as long as the first request took — see `api/drafts.ts`'s own
  // "The run is asynchronous" — the hang here proves that: the first response has already come
  // back by the time the second request fires, and the second is still refused.
  it('refuses a second run of a draft already running with 409', async () => {
    model.hang();
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');

    const first = await run(draft.id, [kase.id]);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('running');

    const second = await run(draft.id, [kase.id]);
    expect(second.statusCode).toBe(409);

    model.release();
    const finished = await waitForRun(first.json().id);
    expect(finished.status).toBe('done');
  });

  it('refuses a member', async () => {
    const draft = await openDraft();
    const res = await run(draft.id, [], true);
    expect(res.statusCode).toBe(403);
  });

  it('leaves the store untouched by a run', async () => {
    const draft = await openDraft([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
    const kase = await addCase('дадите скидку?');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const before = await snapshot(db, agentId);
    const posted = await run(draft.id, [kase.id]);
    expect(posted.statusCode).toBe(200);
    await waitForRun(posted.json().id);

    expect(await snapshot(db, agentId)).toEqual(before);
  });

  // `applyOps` used to throw a plain `Error` for a note the draft names but that is no longer
  // there. Ops apply before the first model call, so no model call is ever spent chasing a
  // draft that could never have applied — that much is unchanged. What changed is where the
  // refusal lands: the response has already gone out by the time this is discovered, so the
  // run's own status is `failed` rather than the request itself answering 409 — see
  // `api/drafts.ts`'s own "A deleted note or rule, named by a draft".
  it('marks the run failed, without spending a model call, for a draft whose note was deleted', async () => {
    const [note] = await db.insert(kbNotes).values({ agentId, path: 'Доставка.md', title: 'Доставка' }).returning();
    // Through the real creation route, not the `openDraft` test helper: `base` has to hold the
    // note's name the way `baseOf` actually captures it (`openDraft` stores an empty `base`).
    const created = await app.inject({
      method: 'POST',
      cookies: jar,
      url: drafts(),
      payload: { title: 'Правка доставки', ops: [{ op: 'note_update', noteId: note!.id, body: 'Новый текст.' }] },
    });
    expect(created.statusCode).toBe(200);
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    await db.delete(kbNotes).where(eq(kbNotes.id, note!.id));

    const posted = await run(created.json().id, [kase.id]);
    expect(posted.statusCode).toBe(200);

    const finished = await waitForRun(posted.json().id);
    expect(finished.status).toBe('failed');
    // No model call spent chasing a draft that could never have applied.
    expect(model.calls).toHaveLength(0);
  });

  it('refuses a draft that does not belong to this agent', async () => {
    const draft = await openDraft();
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });
    const [foreignAgent] = await db.insert(agents).values({ accountId: stranger.accountId, name: 'Чужой' }).returning();
    await db.update(kbDrafts).set({ agentId: foreignAgent!.id }).where(eq(kbDrafts.id, draft.id));

    const res = await run(draft.id, []);
    expect(res.statusCode).toBe(404);
  });
});

describe('reading drafts and runs back', () => {
  it('creates a manual draft and reads it back', async () => {
    const created = await app.inject({
      method: 'POST',
      cookies: jar,
      url: drafts(),
      payload: {
        title: 'Не обещать скидку',
        ops: [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().status).toBe('open');

    const read = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${created.json().id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().ops).toEqual([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
  });

  it('reads a finished run back by id, «было» and «стало» still paired', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    const runId = posted.json().id;
    await waitForRun(runId);

    const res = await app.inject({ method: 'GET', cookies: jar, url: `${drafts()}/${draft.id}/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('done');
    expect(res.json().results).toHaveLength(1);
    // The reload's whole job: «было» sits beside «стало» again, not lost because the run that
    // paid for it has `draft_id is null`.
    expect(res.json().results[0]!.before).not.toBeNull();
    expect(res.json().results[0]!.after).not.toBeNull();
  });

  // `annotate` writes `verdict`/`verdictReason` onto the draft's own `test_results` row (see
  // `runReplay`), but the GET used to build its response through `sideFromRow`, which never
  // carried either column back out — a screen polling this route could never show the hint it
  // asked the model for. `model.replyAlways` here answers the annotation call too, with JSON
  // that does not match `VERDICT_SCHEMA`, so `annotate` itself returns null and the columns
  // stay null in the database — this test is about the two keys reaching the response at all,
  // not about a real verdict, which is `draft-annotate.test.ts`'s own job.
  it("carries the annotation's verdict columns back on GET, not just into the database", async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    await waitForRun(posted.json().id);

    const res = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${draft.id}/runs/${posted.json().id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toHaveProperty('verdict');
    expect(res.json().results[0]).toHaveProperty('verdictReason');
  });

  // The cost used to come back half-reported on GET (`draftCost: run.cost` and no
  // `baselineCost`) and `before.origin` was hardcoded `'reused'` regardless of which run had
  // actually paid for it — a side the POST that made it called `'paid'` came back `'reused'`
  // on every reload. Fixed without a new column: the baseline run paired with a draft run is
  // findable by matching agent/version/model and timing — see `api/drafts.ts`'s own comment on
  // `pairedBaseline`.
  it('reports both costs on GET, and marks a fresh baseline apart from a reused one', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const first = await run(draft.id, [kase.id]);
    await waitForRun(first.json().id);
    const firstRead = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${draft.id}/runs/${first.json().id}`,
    });
    expect(firstRead.statusCode).toBe(200);
    expect(Number(firstRead.json().draftCost)).toBeGreaterThan(0);
    expect(Number(firstRead.json().baselineCost)).toBeGreaterThan(0);
    expect(firstRead.json().results[0]!.after.origin).toBe('paid');
    expect(firstRead.json().results[0]!.before.origin).toBe('paid');

    const second = await openDraft();
    const rerun = await run(second.id, [kase.id]);
    await waitForRun(rerun.json().id);
    const rerunRead = await app.inject({
      method: 'GET',
      cookies: jar,
      url: `${drafts()}/${second.id}/runs/${rerun.json().id}`,
    });
    expect(rerunRead.statusCode).toBe(200);
    expect(Number(rerunRead.json().draftCost)).toBeGreaterThan(0);
    // Nothing paid for «было» this time — the baseline from the first run answers it, on both
    // the total and the per-case label.
    expect(Number(rerunRead.json().baselineCost)).toBe(0);
    expect(rerunRead.json().results[0]!.before.origin).toBe('reused');
  });

  // A run belongs to the one draft it scored, never to a neighbour that merely happens to
  // share an agent — the URL nests a run under a draft, and reading it through a *different*
  // draft's id must not answer for a run that was never scored against that draft.
  it('refuses a run read through a draft it does not belong to', async () => {
    const draft = await openDraft();
    const other = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    const runId = posted.json().id;
    await waitForRun(runId);

    const res = await app.inject({ method: 'GET', cookies: jar, url: `${drafts()}/${other.id}/runs/${runId}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('recovering from a restart', () => {
  // A run's own loop lives only in the memory of the process replaying it — a restart mid-run
  // leaves its `test_runs` row reading `'running'` forever unless something says otherwise.
  // `reconcileOrphanedRuns` is what `index.ts` calls once, before `app.listen()`, to sweep it —
  // not a Fastify hook on `buildServer` itself, precisely because `buildServer` is also what
  // every test in this suite calls, several (`health.test.ts`, `not-found.test.ts`) against a
  // `db` that is never meant to be queried at all. See that function's own comment.
  it('marks a `running` row left behind by a dead process as `failed`, not stuck forever', async () => {
    const draft = await openDraft();
    const [orphan] = await db
      .insert(testRuns)
      .values({ agentId, draftId: draft.id, configVersion: 1, model: 'x', status: 'running' })
      .returning();

    await reconcileOrphanedRuns(db);

    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, orphan!.id));
    expect(row!.status).toBe('failed');
    expect(row!.finishedAt).not.toBeNull();
  });

  // The sweep touches only rows still `'running'` — an already-finished run, however it ended,
  // is left exactly as it was. A restart quietly rewriting a `done` run's own status would be
  // its own bug.
  it('leaves an already-finished run alone', async () => {
    const draft = await openDraft();
    const [finished] = await db
      .insert(testRuns)
      .values({ agentId, draftId: draft.id, configVersion: 1, model: 'x', status: 'done', cost: '0.0001' })
      .returning();

    await reconcileOrphanedRuns(db);

    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, finished!.id));
    expect(row!.status).toBe('done');
    expect(row!.cost).toBe('0.00010000');
  });

  // The one thing this sweep used to get wrong: it marked *every* `running` row `failed`,
  // including a baseline run (`draft_id is null`) that had already written real, paid-for
  // results before the process died — exactly the loss `runReplay`'s own catch closed for the
  // request that is still alive (see the file comment on what `failed` means for a baseline
  // run). A restart must not bury those too.
  it('rescues an orphaned baseline run that already wrote a result, marking it `done`', async () => {
    const kase = await addCase('сколько стоит доставка');
    const [orphanBaseline] = await db
      .insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'x', status: 'running' })
      .returning();
    await db.insert(testResults).values({ runId: orphanBaseline!.id, caseId: kase.id, outcome: 'sent' });

    await reconcileOrphanedRuns(db);

    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, orphanBaseline!.id));
    expect(row!.status).toBe('done');
    expect(row!.finishedAt).not.toBeNull();
  });

  // The rescue is for rows that actually paid for something — a baseline run that died before
  // writing a single result never proved anything and is still `failed`, same as before.
  it('still fails an orphaned baseline run that never wrote a single result', async () => {
    const [orphanBaseline] = await db
      .insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'x', status: 'running' })
      .returning();

    await reconcileOrphanedRuns(db);

    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, orphanBaseline!.id));
    expect(row!.status).toBe('failed');
  });
});
