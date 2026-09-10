/**
 * The route that ties the drafts pipeline together: `POST …/coach/messages/:id/draft` turns a
 * checked coach proposal into a draft, and `POST …/drafts/:draftId/runs` plays it against real
 * conversations without ever touching the store the agent actually answers from.
 *
 * This is also `agent-coaching.md`'s missing piece: the coaching chat's «В черновик» button has
 * had nothing to call until this file exists.
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
  hang(): void;
  release(): void;
}

function fakeModel(): FakeModel {
  const calls: CompletionInput[] = [];
  let script = { text: '', handoff: null as { reason: string } | null };
  let gate: Promise<void> | null = null;
  let open = () => {};

  return {
    calls,
    replyAlways(payload) {
      script = { text: payload.text, handoff: payload.handoff ?? null };
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
      return {
        text: JSON.stringify({
          reply: script.text,
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

async function coachProposed(proposal: CoachProposal) {
  const [row] = await db
    .insert(coachMessages)
    .values({ agentId, role: 'model', text: 'Предложение.', proposal, status: 'pending' })
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

async function addCase(text: string) {
  const [row] = await db
    .insert(testCases)
    .values({ agentId, title: text, messages: [text], origin: 'manual' })
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
});

describe('running a draft over a set of cases', () => {
  it('runs every named case and records a result each', async () => {
    const draft = await openDraft();
    const one = await addCase('сколько стоит доставка');
    const two = await addCase('есть ли рассрочка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const res = await run(draft.id, [one.id, two.id]);

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(2);
    expect(res.json().results[0]!.before).not.toBeNull();
    expect(res.json().results[0]!.after).not.toBeNull();
    expect(res.json().status).toBe('done');
  });

  it('spends nothing on a baseline it already has', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    await run(draft.id, [kase.id]);
    const spent = model.calls.length;

    const second = await openDraft();
    await run(second.id, [kase.id]);

    // One call for the draft side. The baseline is read, not re-run.
    expect(model.calls.length).toBe(spent + 1);
  });

  it('refuses more than twenty cases', async () => {
    const draft = await openDraft();
    const ids = await Promise.all(Array.from({ length: 21 }, (_, i) => addCase(`вопрос ${i}`)));

    const res = await run(draft.id, ids.map((c) => c.id));

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('За один прогон можно проверить не больше двадцати случаев');
  });

  it('refuses a fourth run in flight with 429', async () => {
    model.hang();
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');

    const inFlight = [run(draft.id, [kase.id]), run(draft.id, [kase.id]), run(draft.id, [kase.id])];
    while (model.calls.length < 3) await new Promise((resolve) => setImmediate(resolve));

    expect((await run(draft.id, [kase.id])).statusCode).toBe(429);

    model.release();
    for (const res of await Promise.all(inFlight)) expect(res.statusCode).toBe(200);
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
    const res = await run(draft.id, [kase.id]);
    expect(res.statusCode).toBe(200);

    expect(await snapshot(db, agentId)).toEqual(before);
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

  it('reads a finished run back by id', async () => {
    const draft = await openDraft();
    const kase = await addCase('сколько стоит доставка');
    model.replyAlways({ text: 'Уточню у коллеги.' });

    const posted = await run(draft.id, [kase.id]);
    const runId = posted.json().id;

    const res = await app.inject({ method: 'GET', cookies: jar, url: `${drafts()}/${draft.id}/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('done');
    expect(res.json().results).toHaveLength(1);
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

    const res = await app.inject({ method: 'GET', cookies: jar, url: `${drafts()}/${other.id}/runs/${runId}` });
    expect(res.statusCode).toBe(404);
  });
});
