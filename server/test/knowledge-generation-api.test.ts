import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, contacts, conversations, messages, whatsappNumbers } from '../src/db/schema.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';

const PASSWORD = 'correct-horse-battery';
const env = testEnv();
let db: Awaited<ReturnType<typeof withDb>>;
let app: FastifyInstance;
let agentId: string;
let conversationId: string;
let messageId: string;
let jar: Record<string, string>;
let model: ReturnType<typeof fakeModel>;

beforeEach(async () => {
  db = await withDb();
  const seeded = await createAccountWithOwner(db, { company: 'Generation', email: 'generation-api@example.test', name: 'Owner', initials: 'OW', password: PASSWORD });
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ openrouterKey: encryptSecret('provider-key', Buffer.alloc(32, 7), keyAad(agentId)) }).where(eq(agents.id, agentId));
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: 'api-number', wabaId: 'waba', displayPhone: '+7', accessToken: 'x' }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77000000004' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id }).returning();
  conversationId = conversation!.id;
  const [message] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text', body: 'Delivery takes two days', sentAt: new Date('2026-09-01T10:00:00Z') }).returning();
  messageId = message!.id;
  model = fakeModel('{"proposals":[]}');
  app = buildServer(env, db, { graph: fakeGraph(), model });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'generation-api@example.test', password: PASSWORD } });
  const cookie = login.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

afterEach(async () => app.close());

describe('knowledge generation API', () => {
  it('previews without a model call and starts asynchronously', async () => {
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({
      method: 'POST', url: `${base}/preview`, cookies: jar,
      payload: { conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
    });
    expect(preview.statusCode).toBe(200);
    expect(model.calls).toHaveLength(0);

    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: { previewId: preview.json().previewId, requestKey: 'browser-request' } });
    expect(started.statusCode).toBe(202);
    expect(started.json().id).toBeTruthy();
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status !== 'queued' && detail.json().run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(detail!.json().run.status).toBe('completed');
  });

  it('returns generated proposals for explicit review and draft conversion', async () => {
    model.complete = async (input) => {
      model.calls.push(input);
      return {
        text: JSON.stringify({ proposals: [{ path: 'Delivery', body: 'Two days', sources: [messageId], warnings: [] }] }),
        promptTokens: 10, completionTokens: 4, cost: '0.00100000',
      };
    };
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({ method: 'POST', url: `${base}/preview`, cookies: jar, payload: {
      conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    } });
    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: { previewId: preview.json().previewId, requestKey: 'review-flow' } });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const proposal = detail!.json().proposals.items[0];
    expect(proposal.sources[0]).toMatchObject({ messageId, available: true });

    const edited = await app.inject({ method: 'PATCH', url: `${base}/proposals/${proposal.id}`, cookies: jar, payload: { revision: proposal.revision, body: 'Two business days' } });
    expect(edited.statusCode).toBe(200);
    const draft = await app.inject({ method: 'POST', url: `${base}/runs/${started.json().id}/draft`, cookies: jar, payload: {
      proposalIds: [proposal.id], revisions: { [proposal.id]: edited.json().revision },
    } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draftId).toBeTruthy();
  });
});
