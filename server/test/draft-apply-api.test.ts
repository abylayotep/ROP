/**
 * Applying a draft — the moment its promise (what was tested is what lands) is kept or
 * refused — and discarding one. See `api/drafts.ts`'s own comment on the apply route for the
 * order these checks run in and why each exists.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agentRules,
  agents,
  aiSandboxSessions,
  aiSandboxTurns,
  kbDrafts,
  kbGenerationBatches,
  kbGenerationProposals,
  kbGenerationRuns,
  kbNotes,
  coachMessages,
  responseFeedback,
  testCases,
  testResults,
  testRuns,
  users,
  whatsappNumbers,
} from '../src/db/schema.js';
import type { CompletionInput, ModelClient } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { baseOf, type DraftOp } from '../src/lib/drafts/ops.js';
import { createGenerationDraft } from '../src/lib/knowledge/generation-review.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-draft-apply-api-0123456789';

/** Answers every call the same way — this file never reads a reply's content, only whether a
 * run finished, so there is no reason for anything fancier than `draft-run-api.test.ts`'s own
 * fake carries. */
interface FakeModel extends ModelClient {
  calls: CompletionInput[];
  annotation: { verdict: 'better' | 'same' | 'worse'; reason: string } | null;
}

function fakeModel(): FakeModel {
  const calls: CompletionInput[] = [];
  return {
    calls,
    annotation: null,
    async complete(input) {
      calls.push(input);
      return {
        text: this.annotation && input.messages.some((message) => message.content.includes('ФОРМАТ ОТВЕТА'))
          ? JSON.stringify(this.annotation)
          : JSON.stringify({
          reply: 'Уточню у коллеги.',
          stageId: null,
          fields: {},
          handoff: null,
          usedItemIds: [],
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

/** Computes `base` through the real `baseOf` a draft-creation route would use, rather than the
 * empty `{}` `draft-run-api.test.ts`'s own helper stores — `staleOps` has nothing to compare
 * against without it, and this file's whole point is testing what it refuses. */
async function openDraft(ops: DraftOp[] = []) {
  const base = await baseOf(db, agentId, ops);
  const [row] = await db
    .insert(kbDrafts)
    .values({ agentId, title: 'Черновик', origin: 'manual', status: 'open', ops, base })
    .returning();
  return row!;
}

async function addCase(text: string) {
  const [row] = await db
    .insert(testCases)
    .values({ agentId, title: text, messages: [text], origin: 'manual' })
    .returning();
  return row!;
}

/** Polls for a run to leave `'running'` — see `draft-run-api.test.ts`'s own `waitForRun` for
 * why this can't just trust the POST's timing. */
async function waitForRun(runId: string): Promise<typeof testRuns.$inferSelect> {
  for (let tries = 0; tries < 300; tries += 1) {
    const [row] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
    if (row && row.status !== 'running') return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run never left `running`');
}

/** Runs a draft over a set of cases and waits for the result, the one thing every apply test
 * needs before it can even ask whether applying is allowed. `verdict`, when given, is written
 * onto the run's own results directly rather than coaxed out of the fake model above — the
 * point of the test that uses it is that the *owner's* apply ignores this column no matter
 * what it says, not whether the annotator can be made to say a particular thing. */
async function runOver(
  draft: { id: string },
  cases: { id: string }[],
  opts?: { verdict?: 'better' | 'worse' | 'same' },
) {
  const res = await app.inject({
    method: 'POST',
    cookies: jar,
    url: `${drafts()}/${draft.id}/runs`,
    payload: { caseIds: cases.map((c) => c.id) },
  });
  expect(res.statusCode).toBe(200);
  const finished = await waitForRun(res.json().id);
  if (opts?.verdict) {
    await db
      .update(testResults)
      .set({ verdict: opts.verdict, verdictReason: 'тест' })
      .where(eq(testResults.runId, finished.id));
  }
  return finished;
}

async function addRule(input: { category: 'business' | 'tone' | 'order' | 'forbid'; text: string }) {
  const res = await app.inject({
    method: 'POST',
    cookies: jar,
    url: `/api/agents/${agentId}/rules`,
    payload: input,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function addNote(path: string, body: string) {
  const res = await app.inject({
    method: 'POST',
    cookies: jar,
    url: `/api/agents/${agentId}/knowledge/notes`,
    payload: { path, body },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function editNote(noteId: string, body: string) {
  const res = await app.inject({
    method: 'PATCH',
    cookies: jar,
    url: `/api/agents/${agentId}/knowledge/notes/${noteId}`,
    payload: { body },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function configVersion(): Promise<number> {
  const [row] = await db.select({ configVersion: agents.configVersion }).from(agents).where(eq(agents.id, agentId));
  return row!.configVersion;
}

function apply(draftId: string) {
  return app.inject({ method: 'POST', cookies: jar, url: `${drafts()}/${draftId}/apply` });
}

function getDraft(draftId: string) {
  return app.inject({ method: 'GET', cookies: jar, url: `${drafts()}/${draftId}` });
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

describe('applying a draft', () => {
  async function boundDraft() {
    const draft = await openDraft();
    const kase = await addCase('Сколько доставка?');
    await db.update(testCases).set({ requiredDraftId: draft.id, origin: 'correction' }).where(eq(testCases.id, kase.id));
    return { draft, kase };
  }

  it('refuses a required case whose current run has no result', async () => {
    const { draft, kase } = await boundDraft();
    const run = await runOver(draft, [kase]);
    await db.delete(testResults).where(eq(testResults.runId, run.id));
    expect((await getDraft(draft.id)).json().applicable).toBe(false);
    expect((await apply(draft.id)).statusCode).toBe(409);
  });

  it('refuses a failed required case and applies after a successful rerun', async () => {
    const { draft, kase } = await boundDraft();
    const failed = await runOver(draft, [kase]);
    await db.update(testResults).set({ outcome: 'failed', verdict: 'better', verdictReason: 'Improved.' })
      .where(eq(testResults.runId, failed.id));
    expect((await apply(draft.id)).statusCode).toBe(409);
    model.annotation = { verdict: 'better', reason: 'The corrected answer improves the delivery information.' };
    const passed = await runOver(draft, [kase]);
    const [verified] = await db.select({ verdict: testResults.verdict }).from(testResults)
      .where(eq(testResults.runId, passed.id));
    expect(verified?.verdict).toBe('better');
    await db.update(testResults).set({ outcome: 'sent', reply: 'Доставка стоит 1500 ₸.' })
      .where(eq(testResults.runId, passed.id));
    expect((await getDraft(draft.id)).json()).toMatchObject({ applicable: true, requiredCaseId: kase.id });
    expect((await apply(draft.id)).statusCode).toBe(200);
  });

  for (const verdict of [null, 'same', 'worse'] as const) {
    it(`refuses a delivered required-case reply with ${verdict ?? 'missing'} correction verdict`, async () => {
      const { draft, kase } = await boundDraft();
      const run = await runOver(draft, [kase]);
      await db.update(testResults).set({ outcome: 'sent', reply: 'Бесплатно.', verdict,
        verdictReason: verdict ? 'The correction did not improve the answer.' : null })
        .where(eq(testResults.runId, run.id));
      expect((await getDraft(draft.id)).json().applicable).toBe(false);
      expect((await apply(draft.id)).statusCode).toBe(409);
    });
  }

  it('refuses a required case passed at an older config version', async () => {
    const { draft, kase } = await boundDraft();
    await runOver(draft, [kase]);
    await addRule({ category: 'tone', text: 'На «вы».' });
    expect((await getDraft(draft.id)).json().applicable).toBe(false);
    expect((await apply(draft.id)).statusCode).toBe(409);
  });
  it('creates a required case from saved feedback and refuses an unrelated run', async () => {
    const accountId = (await db.select({ accountId: agents.accountId }).from(agents).where(eq(agents.id, agentId)))[0]!.accountId;
    const [session] = await db.insert(aiSandboxSessions).values({ accountId, agentId }).returning();
    const [turn] = await db.insert(aiSandboxTurns).values({ accountId, agentId, sessionId: session!.id,
      revision: 1, userText: 'Сколько доставка?', reply: 'Бесплатно.', configVersion: 1,
      model: 'test', outcome: 'sent' }).returning();
    const [feedback] = await db.insert(responseFeedback).values({
      accountId,
      agentId,
      sessionId: session!.id, sandboxTurnId: turn!.id, correctionType: 'fact',
      note: 'Доставка стоит 1500 ₸.',
      snapshot: { transcript: 'client: Сколько доставка?\nai: Бесплатно.', responseText: 'Бесплатно.', configVersion: 1, sourceIds: [], sourceRecords: [] },
    }).returning();
    const [message] = await db.insert(coachMessages).values({ agentId, role: 'model', text: 'proposal',
      proposal: { kind: 'note', path: 'Доставка', body: 'Доставка стоит 1500 ₸.' }, feedbackId: feedback!.id,
    }).returning();
    const created = await app.inject({ method: 'POST', cookies: jar,
      url: `/api/agents/${agentId}/coach/messages/${message!.id}/draft`, payload: { revision: 1 } });
    expect(created.statusCode).toBe(200);
    const draft = created.json();
    const required = await db.select().from(testCases).where(eq(testCases.agentId, agentId));
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ messages: ['Сколько доставка?'], expectation: 'Доставка стоит 1500 ₸.', enabled: true });
    const unrelated = await addCase('Другой вопрос');
    const run = await app.inject({ method: 'POST', cookies: jar, url: `${drafts()}/${draft.id}/runs`, payload: { caseIds: [unrelated.id] } });
    expect(run.statusCode).toBe(200);
    await waitForRun(run.json().id);
    const results = await db.select().from(testResults).where(eq(testResults.runId, run.json().id));
    expect(results.map((row) => row.caseId)).toContain(required[0]!.id);
  });
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

  // `note_create` names no existing row, so `staleOps` — which only ever compares a row a
  // draft's `note_update`/`rule_update` already names — has nothing to catch here, and neither
  // does the version check: both drafts are run and applied at the very same `config_version`,
  // so `isDraftApplicable` passes for both. The two applies race for real, at the same instant,
  // over the same `kb_notes(agent_id, path)` unique index `saveNote` writes through — the one
  // gap this route's own checks cannot see coming. The loser must answer a Russian 409, not
  // Postgres's raw `23505` surfacing as a bare 500.
  it('turns two drafts creating the same note path landing at the same instant into one 200 and one 409, never a 500', async () => {
    const path = 'Доставка';
    const draftA = await openDraft([{ op: 'note_create', path, body: 'Курьером, 1500 ₸.' }]);
    const draftB = await openDraft([{ op: 'note_create', path, body: 'Самовывоз, бесплатно.' }]);
    await runOver(draftA, [await addCase('сколько стоит доставка')]);
    await runOver(draftB, [await addCase('есть ли самовывоз')]);

    const [resA, resB] = await Promise.all([apply(draftA.id), apply(draftB.id)]);
    const codes = [resA.statusCode, resB.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const refused = resA.statusCode === 409 ? resA : resB;
    expect(refused.json().message).toContain('уже занят');

    // Exactly one note landed — the loser's op never wrote anything, whatever Postgres's own
    // error looked like from the inside.
    const [note] = await db.select({ body: kbNotes.body }).from(kbNotes).where(eq(kbNotes.path, path));
    expect(note).toBeDefined();
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

  it('increments released generation proposals so a stale draft request cannot recreate a discarded draft', async () => {
    const [owner] = await db.select().from(users).where(eq(users.email, 'owner@example.com'));
    const selection = { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
    const counts = { selectedConversations: 0, selectedMessages: 0, eligibleMessages: 0, eligibleCharacters: 0, skippedAiOrSystem: 0, skippedUnsupported: 0, skippedEmpty: 0, skippedSensitive: 0, skippedOversize: 0, skippedNoSeller: 0 };
    const [run] = await db.insert(kbGenerationRuns).values({ agentId, userId: owner!.id, requestedPreviewId: randomUUID(), requestKey: 'discard-stale', selection, manifest: { messages: [], batches: [] }, counts, modelId: 'model', temperature: '0.30', status: 'completed' }).returning();
    const [batch] = await db.insert(kbGenerationBatches).values({ runId: run!.id, ordinal: 0, manifest: { ordinal: 0, conversationId: randomUUID(), messages: [], characterCount: 0 }, status: 'done' }).returning();
    const [proposal] = await db.insert(kbGenerationProposals).values({ runId: run!.id, batchId: batch!.id, fingerprint: 'discard-stale', path: 'Delivery', body: 'Two days', sources: [] }).returning();
    const input = { proposalIds: [proposal!.id], revisions: { [proposal!.id]: 1 } };
    const draft = await createGenerationDraft(db, agentId, owner!.id, run!.id, input);

    const discarded = await app.inject({ method: 'POST', url: `${drafts()}/${draft.draftId}/discard`, cookies: jar });

    expect(discarded.statusCode).toBe(200);
    await expect(createGenerationDraft(db, agentId, owner!.id, run!.id, input)).rejects.toMatchObject({ statusCode: 409 });
    const [released] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposal!.id));
    expect(released).toMatchObject({ status: 'pending', revision: 2, draftId: null, draftOpIndex: null });
  });

  it('applies over a red verdict, because the owner decides', async () => {
    const draft = await openDraft([{ op: 'rule_create', category: 'tone', text: 'На «ты».' }]);
    await runOver(draft, [await addCase('здравствуйте')], { verdict: 'worse' });
    expect((await apply(draft.id)).statusCode).toBe(200);
  });

  it('refuses a member', async () => {
    const draft = await openDraft();
    expect(
      (await app.inject({ method: 'POST', cookies: memberJar, url: `${drafts()}/${draft.id}/apply` })).statusCode,
    ).toBe(403);
  });
});

/**
 * `GET .../drafts/:draftId` reporting `applicable` and `runs` — the whole point being that a
 * reloaded tab, with no memory of any run it polled itself, answers the same question the
 * apply route itself would. See `api/drafts.ts`'s own comment on `isDraftApplicable` for why
 * both routes call the one function rather than keeping two copies of the same check.
 */
describe('reporting whether a draft is applicable', () => {
  it('reports not applicable, with no run history, for a draft that has never been run', async () => {
    const draft = await openDraft();
    const res = await getDraft(draft.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().applicable).toBe(false);
    expect(res.json().runs).toEqual([]);
  });

  it('reports applicable once a run finishes at the current version — surviving a reload', async () => {
    const draft = await openDraft([{ op: 'rule_create', category: 'tone', text: 'На «вы».' }]);
    const finished = await runOver(draft, [await addCase('здравствуйте')]);

    // A fresh request, exactly what a reloaded tab would make — nothing here carries any
    // memory of the run `runOver` just polled above.
    const res = await getDraft(draft.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().applicable).toBe(true);
    expect(res.json().runs).toHaveLength(1);
    expect(res.json().runs[0]).toMatchObject({
      id: finished.id,
      status: 'done',
      configVersion: finished.configVersion,
    });
  });

  it('reports not applicable once the store moves past the run that proved it', async () => {
    const draft = await openDraft();
    await runOver(draft, [await addCase('сколько стоит доставка')]);
    await addRule({ category: 'tone', text: 'На «вы».' });

    const res = await getDraft(draft.id);
    expect(res.json().applicable).toBe(false);
  });

  it('agrees with the apply route about whether a draft may be applied', async () => {
    const draft = await openDraft([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
    await runOver(draft, [await addCase('дадите скидку?')]);

    expect((await getDraft(draft.id)).json().applicable).toBe(true);
    expect((await apply(draft.id)).statusCode).toBe(200);
  });

  it('lists runs newest first, each with its own costs', async () => {
    const draft = await openDraft();
    const kase = await addCase('первый вопрос');
    const first = await runOver(draft, [kase]);
    const second = await runOver(draft, [kase]);

    const res = await getDraft(draft.id);
    const ids = (res.json().runs as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([second.id, first.id]);
    expect(res.json().runs[0].draftCost).toBeDefined();
    expect(res.json().runs[0].baselineCost).toBeDefined();
  });

  it('refuses a member', async () => {
    const draft = await openDraft();
    const res = await app.inject({ method: 'GET', cookies: memberJar, url: `${drafts()}/${draft.id}` });
    expect(res.statusCode).toBe(403);
  });
});
