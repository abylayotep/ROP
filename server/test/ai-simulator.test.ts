import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  accounts, agents, aiReplies, aiSandboxSessions, aiSandboxTurns, capiEvents,
  contacts, conversations, kaspiPayments, leadFields, leadValues, messages, notes, orders,
  stageTransitions, stages,
} from '../src/db/schema.js';
import { ApiError } from '../src/lib/errors.js';
import { runSimulatorTurn } from '../src/lib/ai/simulator.js';
import type { TurnDeps } from '../src/lib/ai/turn.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { saveNote } from '../src/lib/knowledge/notes.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const key = Buffer.from(testEnv().CREDENTIALS_KEY, 'base64');
const answer = (reply: string, effects: Record<string, unknown> = {}) =>
  JSON.stringify({ reply, stageId: null, fields: {}, handoff: null, usedItemIds: [], ...effects });

let db: Db;
let agentId: string;
let sessionId: string;
let accountId: string;
let stageId: string;
let fieldId: string;
let model: FakeModel;
let graph: ReturnType<typeof fakeGraph>;
let linked: ReturnType<typeof fakeLinked>;
const deps = (): TurnDeps => ({ model, graph, linked, key });
const run = (text: string, revision: number) =>
  runSimulatorTurn(db, deps(), { agentId, sessionId, text, revision });
const runWithCrm = (text: string, revision: number) =>
  runSimulatorTurn(db, { ...deps(), crm: async () => false }, { agentId, sessionId, text, revision });

beforeEach(async () => {
  db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Simulator test' }).returning();
  accountId = account!.id;
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId, accountId, name: 'Sales', aiEnabled: false,
    openrouterKey: encryptSecret('sk-sandbox-model', key, agentId),
  });
  const [session] = await db.insert(aiSandboxSessions)
    .values({ agentId, accountId, title: 'Browser session' }).returning();
  sessionId = session!.id;
  const [stage] = await db.insert(stages)
    .values({ agentId, name: 'Qualified', color: '#ffffff', kind: 'qualified', position: 1 })
    .returning();
  stageId = stage!.id;
  const [field] = await db.insert(leadFields)
    .values({ agentId, name: 'City', kind: 'text', position: 1 })
    .returning();
  fieldId = field!.id;
  model = fakeModel();
  graph = fakeGraph();
  linked = fakeLinked();
});

describe('persistent browser simulator', () => {
  it('uses separate CRM analysis for applied stage and fields, ignoring AI CRM proposals', async () => {
    const [otherStage] = await db.insert(stages).values({ agentId, name: 'Other',
      color: '#ffffff', kind: 'qualified', position: 2 }).returning();
    model = { ...fakeModel(), async complete(input) {
      this.calls.push(input);
      if (input.messages[0]!.content.includes('You maintain CRM records')) {
        const payload = JSON.parse(input.messages[1]!.content) as {
          history: { id: string; body: string }[];
        };
        const latest = payload.history.at(-1)!;
        return { text: JSON.stringify({ stageId, summary: 'Customer is qualified.', confidence: 90,
          profile: {}, fields: { [fieldId]: { value: 'Almaty', messageId: latest.id,
            quote: latest.body } }, checkout: null }), promptTokens: 100,
          completionTokens: 20, cost: '0.00010000' };
      }
      return { text: answer('I can help.', { stageId: otherStage!.id,
        fields: { [fieldId]: 'Invented city' } }), promptTokens: 100,
        completionTokens: 20, cost: '0.00010000' };
    } };

    const turn = await runWithCrm('I live in Almaty. Can you help?', 0);

    expect(turn).toMatchObject({ reply: 'I can help.', stageId, stageName: 'Qualified',
      fields: [{ id: fieldId, name: 'City', value: 'Almaty' }] });
    expect((await db.select().from(aiSandboxSessions))[0])
      .toMatchObject({ revision: 1, stageId,
        fields: [{ id: fieldId, name: 'City', value: 'Almaty' }] });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]!.messages[0]!.content).toContain('You maintain CRM records');
    expect(model.calls[1]!.messages.some((part) => part.content.includes('Qualified')
      && part.content.includes('Almaty'))).toBe(true);
    await runWithCrm('Can we continue?', 1);
    const nextCrmInput = JSON.parse(model.calls[2]!.messages[1]!.content) as {
      previousAnalysis: { stageId: string; summary: string };
      fields: { fieldId: string; value: string }[];
    };
    expect(nextCrmInput.previousAnalysis).toMatchObject({ stageId,
      summary: 'Customer is qualified.' });
    expect(nextCrmInput.fields).toContainEqual({ fieldId, value: 'Almaty' });
  });

  it('captures a grounded checkout proposal without invoking AI reply or creating an order', async () => {
    await db.update(aiSandboxSessions).set({ phone: '77001234567' })
      .where(eq(aiSandboxSessions.id, sessionId));
    model = { ...fakeModel(), async complete(input) {
      this.calls.push(input);
      if (!input.messages[0]!.content.includes('You maintain CRM records')) {
        return { text: answer('Итого 5000 ₸.'), promptTokens: 100,
          completionTokens: 20, cost: '0.00010000' };
      }
      const payload = JSON.parse(input.messages[1]!.content) as {
        history: { id: string; author: string; body: string }[];
      };
      const latest = payload.history.at(-1)!;
      const quoted = payload.history.find((entry) => entry.author === 'ai' && entry.body === 'Итого 5000 ₸.');
      return { text: JSON.stringify({ stageId: null, summary: 'Customer requested payment.',
        confidence: 90, profile: {}, fields: {}, checkout: quoted ? {
          method: 'invoice', messageId: latest.id, quote: latest.body,
          amount: '5000', amountMessageId: quoted.id,
        } : null }), promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
    } };

    await runWithCrm('Is the total 5000 ₸?', 0);
    const turn = await runWithCrm('Оформляйте, пришлите счёт', 1);

    expect(turn).toMatchObject({ outcome: 'checkout', reply: null,
      checkout: { method: 'invoice', amount: '5000' } });
    expect((await db.select().from(aiSandboxTurns))[1])
      .toMatchObject({ checkout: { method: 'invoice', amount: '5000', status: 'would_create' } });
    expect(model.calls).toHaveLength(3);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(kaspiPayments)).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(graph.calls).toEqual([]);
    expect(linked.calls).toEqual([]);
  });
  it('carries its previous reply and proposed lead state into the second production prompt', async () => {
    model = fakeModel(
      answer('Which city?', { stageId, fields: { [fieldId]: 'Almaty' } }),
      answer('We serve Almaty.'),
    );

    const first = await run('I need a quote.', 0);
    const second = await run('I live in Almaty.', 1);

    expect(first).toMatchObject({ revision: 1, reply: 'Which city?', stageId, stageName: 'Qualified',
      fields: [{ id: fieldId, name: 'City', value: 'Almaty' }] });
    expect(second).toMatchObject({ revision: 2, reply: 'We serve Almaty.', stageId: null });
    const prompt = model.calls[1]!.messages;
    expect(prompt.some((part) => part.role === 'assistant' && part.content.includes('Which city?'))).toBe(true);
    expect(prompt.some((part) => part.content.includes('Almaty') && part.content.includes('Qualified'))).toBe(true);
    expect((await db.select().from(aiSandboxSessions).where(eq(aiSandboxSessions.id, sessionId)))[0])
      .toMatchObject({ revision: 2, stageId, fields: [{ id: fieldId, name: 'City', value: 'Almaty' }] });
    expect((await db.select().from(aiSandboxTurns)).map((row) => row.userText))
      .toEqual(['I need a quote.', 'I live in Almaty.']);
  });

  it('uses live retrieval and numeric validation while retaining source IDs and model version', async () => {
    const note = await db.transaction((tx) => saveNote(tx as unknown as Db, {
      agentId, path: 'Delivery', body: 'Delivery costs 1600 tenge.',
    }));
    await db.update(agents).set({ configVersion: 7 }).where(eq(agents.id, agentId));
    model = {
      ...fakeModel(),
      async complete(input) {
        this.calls.push(input);
        const id = /<запись id="([^"]+)"/.exec(input.messages[0]!.content)?.[1];
        return { text: answer('Delivery costs 1600 tenge.', { usedItemIds: id ? [id] : [] }),
          promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
      },
    };
    const turn = await run('How much is delivery?', 0);
    expect(turn.reply).toBe('Delivery costs 1600 tenge.');
    expect(turn.sourceIds).toHaveLength(1);
    expect(turn.usedItems[0]?.title).toContain('Delivery');
    expect(turn.model).toBe('openai/gpt-4o-mini');
    expect(turn.configVersion).toBe(7);
    expect(note.title).toBe('Delivery');

    model = fakeModel(answer('Delivery costs 9999 tenge.'));
    const invented = await run('What about tomorrow?', 1);
    expect(invented).toMatchObject({ reply: null, outcome: 'handoff' });
    expect(invented.handoff).toContain('9999');
  });

  it('writes no production CRM, transport, messaging, or analytics rows', async () => {
    model = fakeModel(
      answer('Which city?', { stageId, fields: { [fieldId]: 'Almaty' } }),
      answer('I will ask a teammate.', { handoff: { reason: 'Needs a person' } }),
    );
    await run('Please help.', 0);
    await run('I live in Almaty.', 1);
    expect(await db.select().from(aiSandboxTurns)).toHaveLength(2);

    const [contactRows, conversationRows, messageRows, leadRows, orderRows,
      replyRows, noteRows, transitionRows, capiRows] = await Promise.all([
      db.select().from(contacts), db.select().from(conversations), db.select().from(messages),
      db.select().from(leadValues), db.select().from(orders), db.select().from(aiReplies),
      db.select().from(notes), db.select().from(stageTransitions), db.select().from(capiEvents),
    ]);
    expect(contactRows).toHaveLength(0);
    expect(conversationRows).toHaveLength(0);
    expect(messageRows).toHaveLength(0);
    expect(leadRows).toHaveLength(0);
    expect(orderRows).toHaveLength(0);
    expect(replyRows).toHaveLength(0);
    expect(noteRows).toHaveLength(0);
    expect(transitionRows).toHaveLength(0);
    expect(capiRows).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
    expect(linked.calls).toHaveLength(0);
  });

  it('rejects stale revisions and foreign agent ownership without spending another model call', async () => {
    model = fakeModel(answer('Hello.'));
    await run('Hello', 0);
    await expect(run('Duplicate', 0)).rejects.toMatchObject({ statusCode: 409 });
    await expect(runSimulatorTurn(db, deps(), { agentId: randomUUID(), sessionId,
      text: 'Foreign', revision: 1 })).rejects.toBeInstanceOf(ApiError);
    expect(model.calls).toHaveLength(1);
    expect(await db.select().from(aiSandboxTurns)).toHaveLength(1);
  });

  it('commits only one of two concurrent answers to the same revision', async () => {
    const scripted = fakeModel(answer('One answer.'));
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model = { ...scripted, async complete(input) {
      const completion = await scripted.complete(input);
      await gate;
      return completion;
    } };
    const calls = [run('First request', 0), run('Second request', 0)];
    while (scripted.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
    release();

    const results = await Promise.allSettled(calls);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected'))
      .toMatchObject([{ status: 'rejected', reason: { statusCode: 409 } }]);
    expect(await db.select().from(aiSandboxTurns)).toHaveLength(1);
    expect((await db.select().from(aiSandboxSessions))[0]!.revision).toBe(1);
  });

  it('does not let a later turn answer after a simulated handoff', async () => {
    model = fakeModel(answer('I will ask a teammate.', { handoff: { reason: 'Needs a person' } }));
    await run('Can I talk to a human?', 0);
    await expect(run('Are you there?', 1)).rejects.toMatchObject({ statusCode: 409 });
    expect(model.calls).toHaveLength(1);
  });

  it('retains the reason after two invalid model answers force a handoff', async () => {
    model = fakeModel('not JSON', 'still not JSON');
    const turn = await run('Please help.', 0);
    expect(turn).toMatchObject({ outcome: 'handoff', reply: null });
    expect(turn.handoff).toContain('дважды');
    expect(turn.detail).toContain('дважды');
    expect(model.calls).toHaveLength(2);
  });

  it('rejects a missing model key without consuming a session revision', async () => {
    await db.update(agents).set({ openrouterKey: null }).where(eq(agents.id, agentId));

    await expect(run('Can you help?', 0)).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.select().from(aiSandboxTurns)).toEqual([]);
    expect((await db.select().from(aiSandboxSessions))[0])
      .toMatchObject({ revision: 0, outcome: null, handoff: null, fields: [] });
    expect(model.calls).toEqual([]);
  });

  it('records a model-call failure only in sandbox state', async () => {
    model = fakeModel(new Error('Model endpoint unavailable'));

    const result = await run('Can you help?', 0);
    expect(result).toMatchObject({ revision: 1, outcome: 'failed', reply: null,
      detail: 'Model endpoint unavailable' });
    expect(await db.select().from(aiSandboxTurns))
      .toMatchObject([{ revision: 1, userText: 'Can you help?', outcome: 'failed',
        detail: 'Model endpoint unavailable' }]);
    expect((await db.select().from(aiSandboxSessions))[0])
      .toMatchObject({ revision: 1, outcome: 'failed' });
    const production = await Promise.all([
      db.select().from(contacts), db.select().from(conversations), db.select().from(messages),
      db.select().from(leadValues), db.select().from(orders), db.select().from(aiReplies),
      db.select().from(notes), db.select().from(stageTransitions), db.select().from(capiEvents),
    ]);
    for (const rows of production) expect(rows).toEqual([]);
    expect(graph.calls).toEqual([]);
    expect(linked.calls).toEqual([]);
  });
});
