import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  agents,
  contacts,
  conversations,
  messages,
  products,
  productVariants,
  promotionItems,
  promotions,
  whatsappNumbers,
} from '../src/db/schema.js';
import { runTurn, type TurnDeps } from '../src/lib/ai/turn.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

let db: Db;
let env: ReturnType<typeof testEnv>;
let key: Buffer;
let agentId: string;
let conversationId: string;
let promotionId: string;

const answer = (reply: string) =>
  JSON.stringify({ reply, stageId: null, fields: {}, handoff: null, photoIds: [], usedItemIds: [] });

const deps = (model: FakeModel): TurnDeps => ({ model, graph: fakeGraph(), linked: fakeLinked(), key, env });

const version = async () =>
  (await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.v;

beforeEach(async () => {
  db = await withDb();
  env = testEnv();
  key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Часы', email: 'owner@promo-turn.test', name: 'Owner', initials: 'OW', password: 'correct-horse-battery',
  });
  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, accountId, name: 'Часы', aiEnabled: true, responseMode: 'live',
    timezone: 'Asia/Tokyo', openrouterKey: encryptSecret('sk-or-promo', key, agentId) });
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: '137', wabaId: 'waba',
    displayPhone: '+7 708 580 79 33', accessToken: encryptSecret('EAAG-token', key, '137') }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77085807933', name: 'Айгуль' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id,
    whatsappNumberId: number!.id, lastInboundAt: new Date(Date.now() - 60_000) }).returning();
  conversationId = conversation!.id;
  await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
    body: 'Сколько стоит R42 40 мм?', sentAt: new Date(Date.now() - 60_000) });

  const [product] = await db.insert(products).values({ agentId, name: 'Корпус R42' }).returning();
  const [forty] = await db.insert(productVariants).values({ productId: product!.id, label: '40 мм', price: 9990 }).returning();
  const [promotion] = await db.insert(promotions).values({ agentId, name: '6990', active: true,
    endsAt: new Date(Date.now() + 3_600_000) }).returning();
  promotionId = promotion!.id;
  await db.insert(promotionItems).values({ promotionId, variantId: forty!.id, promoPrice: 6990 });
});

describe('a promotion in a live turn', () => {
  it('shows the promotion and treats its price as sourced', async () => {
    const model = fakeModel(answer('R42 40 мм по акции 6 990 ₸, обычная цена 9 990 ₸.'));
    const result = await runTurn(db, deps(model), { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('- 40 мм: по акции 6 990 ₸ (обычная цена 9 990 ₸)');
    expect(prompt).toContain('Название: 6990');
  });

  it('drops an expired promotion from the prompt, switches it off and bumps the version before the turn', async () => {
    await db.update(promotions).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(promotions.id, promotionId));
    const start = await version();
    const model = fakeModel(answer('R42 40 мм стоит 6 990 ₸.'));
    const result = await runTurn(db, deps(model), { agentId, conversationId });

    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).not.toContain('АКЦИЯ');
    expect(prompt).toContain('- 40 мм: 9 990 ₸');
    // The old promotional price is no longer a source.
    expect(result.outcome).not.toBe('sent');
    expect(await version()).toBe(start + 1);
    const [row] = await db.select().from(promotions).where(eq(promotions.id, promotionId));
    expect(row!.active).toBe(false);
  });
});
