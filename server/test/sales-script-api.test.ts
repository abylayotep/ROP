import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, contacts, conversations, leadFields, productPhotos, products, salesScriptSteps, stages, whatsappNumbers } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let jar: Record<string, string>;
let memberJar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const path = () => `/api/agents/${agentId}/script`;
const put = (steps: unknown[], cookies = jar) =>
  app.inject({ method: 'PUT', url: path(), cookies, payload: { steps } });
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, parentId: null, title: `Шаг ${id}`, ...over });

async function photoOf(owner: string): Promise<string> {
  const [product] = await db.insert(products).values({ agentId: owner, name: 'Экслибрис' }).returning();
  const [photo] = await db.insert(productPhotos).values({ productId: product!.id, mediaPath: 'x.jpg',
    mediaMime: 'image/jpeg', sizeBytes: 1 }).returning();
  return photo!.id;
}

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse', email: 'owner@script.test', name: 'Владелец', initials: 'ВЛ', password: PASSWORD,
  }));
  await addMember(db, { company: 'Sealhouse', email: 'member@script.test', name: 'Оператор', initials: 'ОП',
    password: PASSWORD, role: 'member' });
  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@script.test');
  memberJar = await login('member@script.test');
  const created = await app.inject({ method: 'POST', url: `/api/accounts/${accountId}/agents`, cookies: jar,
    payload: { name: 'Sealhouse' } });
  agentId = created.json().id;
});

afterEach(async () => {
  await app.close();
});

describe('sales script API', () => {
  it('saves a chain with a branch, answers it flat in order and bumps the config version', async () => {
    const [before] = await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId));
    const res = await put([
      step('tmp-1', { title: 'Приветствие' }),
      step('tmp-2', { title: 'Фото дизайнов', condition: 'не для основной цепочки' }),
      step('tmp-3', { title: 'Оплата', waitPayment: true }),
      step('tmp-b', { parentId: 'tmp-2', title: 'Сомневается', condition: 'Клиент сомневается' }),
    ]);
    expect(res.statusCode).toBe(200);
    const steps = res.json().steps as { id: string; parentId: string | null; title: string; condition: string; position: number; waitPayment: boolean }[];
    expect(steps.map((s) => s.title)).toEqual(['Приветствие', 'Фото дизайнов', 'Сомневается', 'Оплата']);
    expect(steps[2]!.parentId).toBe(steps[1]!.id);
    expect(steps[2]!.condition).toBe('Клиент сомневается');
    // A condition belongs to branches only.
    expect(steps[1]!.condition).toBe('');
    expect(steps[3]!.waitPayment).toBe(true);
    expect(steps.every((s) => /^[0-9a-f-]{36}$/.test(s.id))).toBe(true);
    const [after] = await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId));
    expect(after!.v).toBe(before!.v + 1);

    const read = await app.inject({ method: 'GET', url: path(), cookies: memberJar });
    expect(read.statusCode).toBe(200);
    expect(read.json().steps).toEqual(steps);
  });

  it('keeps existing ids across saves, so a conversation stays on its step, and deletes removed steps', async () => {
    const first = (await put([step('tmp-1'), step('tmp-2'), step('tmp-3')])).json().steps as { id: string }[];
    const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: '77', wabaId: 'w',
      displayPhone: '+7', accessToken: 'x' }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: '77000000000' }).returning();
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id,
      whatsappNumberId: number!.id, scriptStepId: first[1]!.id }).returning();

    // Reordered, the middle one moved under the first as a branch, the last one removed.
    const second = await put([
      step(first[0]!.id, { title: 'Первый' }),
      step(first[1]!.id, { parentId: first[0]!.id, title: 'Теперь ветка', condition: 'если' }),
      step('tmp-new', { title: 'Новый' }),
    ]);
    expect(second.statusCode).toBe(200);
    const steps = second.json().steps as { id: string; parentId: string | null; title: string }[];
    expect(steps.map((s) => [s.title, s.parentId])).toEqual([
      ['Первый', null], ['Теперь ветка', first[0]!.id], ['Новый', null],
    ]);
    expect(steps[1]!.id).toBe(first[1]!.id);
    expect(steps.some((s) => s.id === first[2]!.id)).toBe(false);
    const [kept] = await db.select().from(conversations).where(eq(conversations.id, conversation!.id));
    expect(kept!.scriptStepId).toBe(first[1]!.id);

    // A branch moved back out while its old parent is deleted survives the cascade.
    const third = await put([step(first[1]!.id, { title: 'Снова основной' })]);
    expect(third.json().steps.map((s: { id: string }) => s.id)).toEqual([first[1]!.id]);
  });

  it('refuses the PUT to a member but lets them read', async () => {
    expect((await put([step('tmp-1')], memberJar)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: path(), cookies: memberJar })).statusCode).toBe(200);
  });

  it('validates limits, parents and depth', async () => {
    const tooMany = Array.from({ length: 41 }, (_, i) => step(`tmp-${i}`));
    expect((await put(tooMany)).json().message).toContain('не больше 40');
    expect((await put([step('tmp-1', { title: ' ' })])).statusCode).toBe(400);
    expect((await put([step('tmp-1', { title: 'а'.repeat(81) })])).statusCode).toBe(400);
    expect((await put([step('tmp-1', { instructions: 'а'.repeat(2001) })])).statusCode).toBe(400);
    expect((await put([step('tmp-1', { parentId: 'tmp-nope' })])).statusCode).toBe(400);
    expect((await put([step('tmp-1', { parentId: 'tmp-1' })])).statusCode).toBe(400);
    const deep = await put([step('tmp-1'), step('tmp-2', { parentId: 'tmp-1' }), step('tmp-3', { parentId: 'tmp-2' })]);
    expect(deep.statusCode).toBe(400);
    expect(deep.json().message).toContain('не может быть своих веток');
    expect((await put([step('tmp-1'), step('tmp-1')])).statusCode).toBe(400);
    expect((await put([step('not-an-id')])).statusCode).toBe(400);
    const photos = await Promise.all([1, 2, 3, 4, 5].map(() => photoOf(agentId)));
    expect((await put([step('tmp-1', { photoIds: photos.slice(0, 4) })])).statusCode).toBe(200);
    expect((await put([step('tmp-1', { photoIds: photos })])).json().message).toContain('не больше 4 фото');
  });

  it('refuses ids of another agent: photos, fields, stages and steps', async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Чужой' }).returning();
    const foreignPhoto = await photoOf(other!.id);
    const [foreignField] = await db.insert(leadFields).values({ agentId: other!.id, name: 'Адрес', kind: 'text', position: 0 }).returning();
    const [foreignStage] = await db.insert(stages).values({ agentId: other!.id, name: 'Чужой', color: '#000', kind: 'active', position: 0 }).returning();
    expect((await put([step('tmp-1', { photoIds: [foreignPhoto] })])).json().message).toContain('Фото нет');
    expect((await put([step('tmp-1', { fieldIds: [foreignField!.id] })])).json().message).toContain('Поля нет');
    expect((await put([step('tmp-1', { stageId: foreignStage!.id })])).json().message).toContain('Этапа нет');

    const own = await photoOf(agentId);
    const [field] = await db.insert(leadFields).values({ agentId, name: 'Адрес', kind: 'text', position: 99 }).returning();
    const ok = await put([step('tmp-1', { photoIds: [own], fieldIds: [field!.id] })]);
    expect(ok.statusCode).toBe(200);

    // A step id this agent does not have — another agent's, or one deleted by a concurrent save.
    const [theirs] = await db.insert(salesScriptSteps).values({ agentId: other!.id, position: 0, title: 'чужой' }).returning();
    const theirId = theirs!.id;
    expect((await put([step(theirId)])).statusCode).toBe(409);
  });
});
