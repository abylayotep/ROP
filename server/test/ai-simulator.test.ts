import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  accounts, agents, aiReplies, aiSandboxSessions, aiSandboxTurns, capiEvents,
  contacts, conversations, leadFields, leadValues, messages, notes, orders,
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
    model = fakeModel(answer('I will ask a teammate.', {
      stageId, fields: { [fieldId]: 'Almaty' }, handoff: { reason: 'Needs a person' },
    }));
    await run('Please help.', 0);
    const production = await Promise.all([
      db.select().from(contacts), db.select().from(conversations), db.select().from(messages),
      db.select().from(leadValues), db.select().from(orders), db.select().from(aiReplies),
      db.select().from(notes), db.select().from(stageTransitions), db.select().from(capiEvents),
    ]);
    for (const rows of production) expect(rows).toEqual([]);
    expect(graph.calls).toEqual([]);
    expect(linked.calls).toEqual([]);
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
});
