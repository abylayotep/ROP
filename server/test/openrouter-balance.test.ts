import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import {
  checkOpenRouterBalances,
  formatLowBalanceAlert,
  LOW_BALANCE_REPEAT_MS,
} from '../src/lib/ai/balance.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const OPERATOR = '77716944499';

let db: Db;
let graph: FakeGraph;
let agentId: string;
let balance: number | null;
const readKeys: string[] = [];

const check = (now = new Date()) => checkOpenRouterBalances(db, {
  graph, linked: fakeLinked(), key,
  readCredits: async (secret) => { readKeys.push(secret); return balance; },
}, now);
const alerts = () => graph.calls.filter((call) => call.method === 'sendText' && call.args[2] === OPERATOR);
const agentRow = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

beforeEach(async () => {
  db = await withDb();
  graph = fakeGraph();
  readKeys.length = 0;
  balance = 3.2;
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Печати', email: 'owner@balance.test', name: 'Владелец', initials: 'ВЛ', password: 'correct-horse-battery',
  });
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId, accountId, name: 'Sealhouse', aiEnabled: true, responseMode: 'test',
    operatorNotifyPhone: OPERATOR, openrouterKey: encryptSecret('sk-or-balance', key, agentId),
  });
  await db.insert(whatsappNumbers).values({
    agentId, phoneNumberId: '136', wabaId: 'waba', displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret('EAAG-token', key, '136'),
  });
});

describe('formatLowBalanceAlert', () => {
  it('says how much is left and where to top up', () => {
    const text = formatLowBalanceAlert('Sealhouse', 3.204);
    expect(text).toContain('осталось $3.20');
    expect(text).toContain('«Sealhouse»');
    expect(text).toContain('https://openrouter.ai/settings/credits');
  });

  it('says the balance is gone once nothing is left', () => {
    expect(formatLowBalanceAlert('Sealhouse', -0.4)).toContain('закончился ($0.00)');
  });
});

describe('checkOpenRouterBalances', () => {
  it('warns the operator once with the agent key and remembers it', async () => {
    const now = new Date();
    expect(await check(now)).toEqual([]);
    expect(readKeys).toEqual(['sk-or-balance']);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.args[3]).toContain('$3.20');
    expect((await agentRow()).lowBalanceAlertedAt?.getTime()).toBe(now.getTime());

    // A restart an hour later must not repeat it.
    await check(new Date(now.getTime() + 60 * 60_000));
    expect(alerts()).toHaveLength(1);
  });

  it('repeats the warning a day later while the balance is still low', async () => {
    const now = new Date();
    await check(now);
    await check(new Date(now.getTime() + LOW_BALANCE_REPEAT_MS + 1));
    expect(alerts()).toHaveLength(2);
  });

  it('stays quiet above the threshold and re-arms after a top-up', async () => {
    const now = new Date();
    await check(now);
    balance = 40;
    await check(new Date(now.getTime() + 60_000));
    expect((await agentRow()).lowBalanceAlertedAt).toBeNull();
    expect(alerts()).toHaveLength(1);

    balance = 1;
    await check(new Date(now.getTime() + 120_000));
    expect(alerts()).toHaveLength(2);
  });

  it('does nothing when the balance cannot be read', async () => {
    balance = null;
    await check();
    expect(alerts()).toHaveLength(0);
    expect((await agentRow()).lowBalanceAlertedAt).toBeNull();
  });

  it('skips an agent with no operator phone or no enabled number', async () => {
    await db.update(agents).set({ operatorNotifyPhone: null }).where(eq(agents.id, agentId));
    await check();
    expect(readKeys).toEqual([]);

    await db.update(agents).set({ operatorNotifyPhone: OPERATOR }).where(eq(agents.id, agentId));
    await db.update(whatsappNumbers).set({ enabled: false }).where(eq(whatsappNumbers.agentId, agentId));
    await check();
    expect(alerts()).toHaveLength(0);
    expect((await agentRow()).lowBalanceAlertedAt).toBeNull();
  });
});
