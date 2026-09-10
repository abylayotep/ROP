import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiDeps } from '../src/api/ai.js';
import type { Db } from '../src/db/client.js';
import {
  accounts,
  agentRules,
  agents,
  contacts,
  conversations,
  kbChunks,
  kbLinks,
  kbNotes,
  messages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { replayCase } from '../src/lib/drafts/replay.js';
import type { ChatMessage, CompletionInput, ModelClient } from '../src/lib/ai/openrouter.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

/** The OpenRouter key this agent holds. No test may let it out of the process. */
const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef';
const WHATSAPP_TOKEN = 'EAAG-token';

interface ScriptedModel extends ModelClient {
  /** Every call in order, so a test can assert what the model was actually told. */
  calls: CompletionInput[];
  /** Queues the agent's next answer. Several calls script several turns, answered in order. */
  reply(input: {
    text: string;
    stageId?: string | null;
    fields?: Record<string, string>;
    handoff?: { reason: string } | null;
  }): void;
  /** The `CompletionInput` of the call at this position, or undefined if it never happened. */
  callsAt(index: number): CompletionInput | undefined;
  /** The messages the most recent call was given. */
  readonly lastMessages: ChatMessage[];
}

/**
 * A model that answers from a script and cites every record it was shown.
 *
 * Citing everything rather than nothing spares a test from hand-computing chunk ids of its
 * own: `prompt.ts`'s `<запись id="…">` tag is the only place an id appears in the system
 * message, so reading it back out of what the model was sent is what a real model does when
 * it names the records it used — just without the judgment a real one applies about which of
 * several records actually mattered.
 */
function scriptedModel(): ScriptedModel {
  const calls: CompletionInput[] = [];
  const answers: string[] = [];

  return {
    calls,
    reply({ text, stageId = null, fields = {}, handoff = null }) {
      answers.push(JSON.stringify({ reply: text, stageId, fields, handoff, usedItemIds: [] }));
    },
    async complete(input) {
      calls.push(input);
      const scripted = answers[Math.min(calls.length - 1, answers.length - 1)] ?? '{}';
      const parsed = JSON.parse(scripted) as Record<string, unknown>;
      const prompt = input.messages.map((message) => message.content).join('\n');
      const usedItemIds = [...prompt.matchAll(/<запись id="([^"]+)"/g)].map((match) => match[1]);
      return {
        text: JSON.stringify({ ...parsed, usedItemIds }),
        promptTokens: 100,
        completionTokens: 20,
        cost: '0.00010000',
      };
    },
    callsAt: (index) => calls[index],
    get lastMessages() {
      return calls.at(-1)?.messages ?? [];
    },
  };
}

/**
 * Every row `replayCase` could possibly write, before the transaction that writes them is
 * always rolled back: the draft's own tables (`kb_notes`, `kb_chunks`, `kb_links`,
 * `agent_rules`, via `applyOps`) and the fake conversation's (`contacts`, `conversations`,
 * `messages`). Nothing else is reachable — `runTurn`'s own writes (`ai_replies`, `lead_values`,
 * the handoff `notes`, `stage_transitions`) are every one of them gated on `dryRun`, which
 * `replayCase` always passes as `true`, and that gate is `ai-turn.test.ts`'s own claim to
 * prove, not this file's. This is what makes "leaves the store as it found it" a fact about
 * `replayCase` rather than a restatement of `dryRun`'s existing promise.
 */
async function snapshot(db: Db, agentId: string) {
  return {
    notes: await db.select().from(kbNotes).where(eq(kbNotes.agentId, agentId)).orderBy(asc(kbNotes.id)),
    chunks: await db
      .select()
      .from(kbChunks)
      .where(eq(kbChunks.agentId, agentId))
      .orderBy(asc(kbChunks.id)),
    links: await db.select().from(kbLinks).where(eq(kbLinks.agentId, agentId)).orderBy(asc(kbLinks.id)),
    rules: await db
      .select()
      .from(agentRules)
      .where(eq(agentRules.agentId, agentId))
      .orderBy(asc(agentRules.id)),
    contacts: await db
      .select()
      .from(contacts)
      .where(eq(contacts.agentId, agentId))
      .orderBy(asc(contacts.id)),
    conversations: await db
      .select()
      .from(conversations)
      .where(eq(conversations.agentId, agentId))
      .orderBy(asc(conversations.id)),
    // `messages` carries no `agentId` of its own, so it is scoped through the conversation it
    // sits on — exactly how a real message is always reached.
    messages: await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        direction: messages.direction,
        author: messages.author,
        kind: messages.kind,
        body: messages.body,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(conversations.agentId, agentId))
      .orderBy(asc(messages.sentAt), asc(messages.id)),
  };
}

let db: Db;
let deps: AiDeps;
let model: ScriptedModel;
let agentId: string;
let numberId: string;

beforeEach(async () => {
  db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Сафина' }).returning();

  // Minted here rather than read back, because the OpenRouter key is sealed against it and
  // the row carries the sealed value from the start — the same reason `ai-turn.test.ts` does.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId: account!.id,
    name: 'Сафина',
    aiEnabled: true,
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, agentId),
  });

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret(WHATSAPP_TOKEN, key, '136'),
    })
    .returning();
  numberId = number!.id;

  model = scriptedModel();
  deps = { model, graph: fakeGraph() };
});

describe('replaying a case', () => {
  it('answers from the draft rather than from the store', async () => {
    model.reply({ text: 'Доставка 1600 ₸.' });

    const result = await replayCase(db, deps, {
      agentId,
      numberId,
      key,
      messages: ['сколько стоит доставка'],
      ops: [{ op: 'note_create', path: 'Доставка', body: '1600 ₸.' }],
    });

    expect(result.outcome).not.toBe('failed');
    expect(model.lastMessages.some((m) => m.content.includes('1600 ₸.'))).toBe(true);
  });

  it('leaves the store exactly as it found it', async () => {
    const before = await snapshot(db, agentId);

    await replayCase(db, deps, {
      agentId,
      numberId,
      key,
      messages: ['здравствуйте'],
      ops: [{ op: 'note_create', path: 'Доставка', body: '1600 ₸.' }],
    });

    expect(await snapshot(db, agentId)).toEqual(before);
  });

  it('carries the conversation forward across messages', async () => {
    model.reply({ text: 'Какие двери нужны?' });
    model.reply({ text: 'Входные — от 80 000 ₸.' });

    await replayCase(db, deps, {
      agentId,
      numberId,
      key,
      messages: ['здравствуйте', 'входные'],
      ops: [],
    });

    const second = model.callsAt(1)!.messages.map((m) => m.content).join('\n');
    expect(second).toContain('Какие двери нужны?');
  });

  it('reports the sections the reply was built from', async () => {
    model.reply({ text: 'Доставка 1600 ₸.' });

    const result = await replayCase(db, deps, {
      agentId,
      numberId,
      key,
      messages: ['сколько стоит доставка'],
      ops: [{ op: 'note_create', path: 'Доставка', body: '## По городу\n1600 ₸.' }],
    });

    expect(result.usedChunkIds).toHaveLength(1);
  });

  it('reports a handoff and its reason instead of a reply', async () => {
    model.reply({ text: 'Скидка 90%.' });

    const result = await replayCase(db, deps, {
      agentId,
      numberId,
      key,
      messages: ['дадите скидку?'],
      ops: [],
    });

    expect(result.handoff).toBe(true);
    expect(result.handoffReason).toContain('90');
    expect(result.reply).toBeNull();
  });
});
