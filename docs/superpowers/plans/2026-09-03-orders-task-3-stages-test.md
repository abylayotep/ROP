### Task 3 — the test file

This is step 1 of [task 3](2026-09-03-orders-task-3-stages-api.md). It lives in its own
document so that neither crosses the five-hundred-line limit this repository keeps. Copy it
verbatim; the values in it are the task's requirements.

- [ ] **Step 1: Write the failing test**

Create `server/test/stages-api.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  agents,
  contacts,
  conversations,
  leadFields,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** The stage of a given name, straight from the database. */
async function stageNamed(name: string) {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.name === name)!;
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

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('stages', () => {
  it('lists the seeded funnel in order', async () => {
    const res = await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; position: number }[];
    expect(body[0]?.name).toBe('Новый лид');
    expect(body.at(-1)?.name).toBe('Отказ');
    expect(body.map((stage) => stage.position)).toEqual(body.map((_, i) => i));
  });

  it('adds a stage at the end', async () => {
    const before = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages`,
      cookies: jar,
      payload: { name: 'Подбор товара', color: '#4b8ef0', kind: 'active' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().position).toBe(before.length);
    expect(res.json().autoMessage).toBeNull();
  });

  it('moves the sale when another stage is promoted', async () => {
    const invoice = await stageNamed('Счёт отправлен');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${invoice.id}`,
      cookies: jar,
      payload: { kind: 'success' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('success');
    expect((await stageNamed('Продажа')).kind).toBe('active');
    const all = await db.select().from(stages).where(eq(stages.agentId, agentId));
    expect(all.filter((stage) => stage.kind === 'success')).toHaveLength(1);
  });

  it('moves the sale onto a stage created as the sale', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages`,
      cookies: jar,
      payload: { name: 'Оплачено', color: '#0d9668', kind: 'success' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('success');
    expect((await stageNamed('Продажа')).kind).toBe('active');
    const all = await db.select().from(stages).where(eq(stages.agentId, agentId));
    expect(all.filter((stage) => stage.kind === 'success')).toHaveLength(1);
  });

  it('refuses to leave the funnel without a sale stage', async () => {
    const sale = await stageNamed('Продажа');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${sale.id}`,
      cookies: jar,
      payload: { kind: 'active' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('стадия продажи');
  });

  it('renames and retemplates a stage', async () => {
    const stage = await stageNamed('Новый лид');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: jar,
      payload: {
        name: 'Заявка',
        description: 'Клиент написал впервые и ещё ничего не спросил',
        autoMessage: 'Здравствуйте, {{name}}! Сейчас подберём.',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Заявка');
    expect(res.json().autoMessage).toBe('Здравствуйте, {{name}}! Сейчас подберём.');
  });

  it('clears a template with an empty string', async () => {
    const stage = await stageNamed('Новый лид');
    await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: jar,
      payload: { autoMessage: 'Здравствуйте!' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: jar,
      payload: { autoMessage: '' },
    });

    expect(res.json().autoMessage).toBeNull();
  });

  it('refuses to delete a stage that still holds conversations', async () => {
    const stage = await stageNamed('В диалоге');
    await db
      .update(conversations)
      .set({ stageId: stage.id })
      .where(eq(conversations.id, conversationId));

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('1');
  });

  it('deletes an empty stage', async () => {
    const stage = await stageNamed('В диалоге');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(stages).where(eq(stages.id, stage.id))).toHaveLength(0);
  });

  it('refuses to delete the sale stage', async () => {
    const sale = await stageNamed('Продажа');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/stages/${sale.id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(409);
  });

  it('rewrites every position on reorder', async () => {
    const list = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json() as {
      id: string;
      name: string;
    }[];
    const ids = [list.at(-1)!.id, ...list.slice(0, -1).map((stage) => stage.id)];

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages/order`,
      cookies: jar,
      payload: { ids },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; position: number }[];
    expect(body.map((stage) => stage.id)).toEqual(ids);
    expect(body.map((stage) => stage.position)).toEqual(ids.map((_, i) => i));
  });

  it('refuses a reorder that does not name every stage', async () => {
    const list = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json() as {
      id: string;
    }[];

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages/order`,
      cookies: jar,
      payload: { ids: list.slice(1).map((stage) => stage.id) },
    });

    expect(res.statusCode).toBe(400);
  });

  it('lets a member read but not change the funnel', async () => {
    const memberJar = await login('member@example.com');

    const read = await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: memberJar });
    const write = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages`,
      cookies: memberJar,
      payload: { name: 'Своя', color: '#4b8ef0', kind: 'active' },
    });

    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(403);
  });

  it("answers 404 for another agent's stage", async () => {
    const [other] = await db.insert(agents).values({
      accountId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.accountId,
      name: 'Другая',
    }).returning();
    const [stage] = await db
      .insert(stages)
      .values({ agentId: other!.id, name: 'Чужая', color: '#fff', kind: 'active', position: 0 })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${stage!.id}`,
      cookies: jar,
      payload: { name: 'Взлом' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for a stage id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/stages/не-uuid`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('lead fields', () => {
  it('starts empty and appends in order', async () => {
    const empty = await app.inject({ url: `/api/agents/${agentId}/lead-fields`, cookies: jar });
    expect(empty.json()).toEqual([]);

    const city = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text', hint: 'Откуда клиент' },
    });
    const sum = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Бюджет', kind: 'number' },
    });

    expect(city.json().position).toBe(0);
    expect(sum.json().position).toBe(1);
    expect(sum.json().hint).toBe('');
  });

  it('refuses a second field with the same name', async () => {
    const payload = { name: 'Город', kind: 'text' };
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload,
    });

    expect(res.statusCode).toBe(409);
  });

  it('refuses a kind nobody can render', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Файл', kind: 'attachment' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('deletes a field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/lead-fields/${created.json().id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(leadFields)).toHaveLength(0);
  });
});
```

