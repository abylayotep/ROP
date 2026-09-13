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

  it('refuses the removed awaiting_payment kind', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/stages`, cookies: jar,
      payload: { name: 'Ждёт оплаты', color: '#e0a13a', kind: 'awaiting_payment' } });
    expect(created.statusCode).toBe(400);
    const ready = await stageNamed('Готов к покупке');
    const patched = await app.inject({ method: 'PATCH', url: `/api/agents/${agentId}/stages/${ready.id}`, cookies: jar,
      payload: { kind: 'awaiting_payment' } });
    expect(patched.statusCode).toBe(400);
  });

  it('moves the sale when another stage is promoted', async () => {
    const ready = await stageNamed('Готов к покупке');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${ready.id}`,
      cookies: jar,
      payload: { kind: 'success' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('success');
    expect((await stageNamed('Оплачено')).kind).toBe('active');
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
    expect((await stageNamed('Оплачено')).kind).toBe('active');
    const all = await db.select().from(stages).where(eq(stages.agentId, agentId));
    expect(all.filter((stage) => stage.kind === 'success')).toHaveLength(1);
  });

  it('refuses to leave the funnel without a sale stage', async () => {
    const sale = await stageNamed('Оплачено');

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
    expect(res.json().message).toContain('1 диалог');
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
    const sale = await stageNamed('Оплачено');

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

  it("refuses a reorder carrying another agent's stage", async () => {
    const [other] = await db.insert(agents).values({
      accountId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.accountId,
      name: 'Другая',
    }).returning();
    const [foreign] = await db
      .insert(stages)
      .values({ agentId: other!.id, name: 'Чужая', color: '#fff', kind: 'active', position: 0 })
      .returning();
    const list = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json() as {
      id: string;
    }[];

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages/order`,
      cookies: jar,
      payload: { ids: [foreign!.id, ...list.slice(1).map((stage) => stage.id)] },
    });

    expect(res.statusCode).toBe(400);
    // The funnel is untouched: a refused reorder must not half-apply.
    const after = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json() as {
      id: string;
    }[];
    expect(after.map((stage) => stage.id)).toEqual(list.map((stage) => stage.id));
  });

  it('refuses a reorder that names one stage twice', async () => {
    const list = (await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: jar })).json() as {
      id: string;
    }[];

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages/order`,
      cookies: jar,
      payload: { ids: [list[0]!.id, ...list.map((stage) => stage.id)] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('lets a member read but not change the funnel', async () => {
    const memberJar = await login('member@example.com');
    const stage = await stageNamed('В диалоге');

    const read = await app.inject({ url: `/api/agents/${agentId}/stages`, cookies: memberJar });
    const create = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages`,
      cookies: memberJar,
      payload: { name: 'Своя', color: '#4b8ef0', kind: 'active' },
    });
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: memberJar,
      payload: { name: 'Своя' },
    });
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/stages/${stage.id}`,
      cookies: memberJar,
    });
    const order = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/stages/order`,
      cookies: memberJar,
      payload: { ids: [stage.id] },
    });
    const field = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: memberJar,
      payload: { name: 'Город', kind: 'text' },
    });

    expect(read.statusCode).toBe(200);
    expect(create.statusCode).toBe(403);
    expect(rename.statusCode).toBe(403);
    expect(remove.statusCode).toBe(403);
    expect(order.statusCode).toBe(403);
    expect(field.statusCode).toBe(403);
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

  it('leaves one sale stage when two promotions race', async () => {
    const dialog = await stageNamed('В диалоге');
    const interest = await stageNamed('Интерес проявлен');

    // Both in flight at once. Without the row lock on the agent neither transaction sees
    // the other's uncommitted demotion, both commit, and the funnel keeps two sale stages
    // — a state the cabinet cannot leave, since demoting or deleting either is a 409.
    await Promise.all(
      [dialog, interest].map((stage) =>
        app.inject({
          method: 'PATCH',
          url: `/api/agents/${agentId}/stages/${stage.id}`,
          cookies: jar,
          payload: { kind: 'success' },
        }),
      ),
    );

    const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
    expect(rows.filter((row) => row.kind === 'success')).toHaveLength(1);
  });

  it('leaves one sale stage when a promotion races a create', async () => {
    const dialog = await stageNamed('В диалоге');

    await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}/stages/${dialog.id}`,
        cookies: jar,
        payload: { kind: 'success' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/stages`,
        cookies: jar,
        payload: { name: 'Оплачено', color: '#0d9668', kind: 'success' },
      }),
    ]);

    const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
    expect(rows.filter((row) => row.kind === 'success')).toHaveLength(1);
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

  it('renames a field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/lead-fields/${created.json().id}`,
      cookies: jar,
      payload: { name: 'Город клиента', hint: 'Откуда он пишет' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Город клиента');
    expect(res.json().hint).toBe('Откуда он пишет');
  });

  it('refuses a rename onto another field of the same name', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });
    const budget = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Бюджет', kind: 'number' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/lead-fields/${budget.json().id}`,
      cookies: jar,
      payload: { name: 'Город' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('answers 404 for a field id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/lead-fields/не-uuid`,
      cookies: jar,
      payload: { name: 'Взлом' },
    });

    expect(res.statusCode).toBe(404);
  });

  it("answers 404 for another agent's field", async () => {
    const [other] = await db.insert(agents).values({
      accountId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.accountId,
      name: 'Другая',
    }).returning();
    const [foreign] = await db
      .insert(leadFields)
      .values({ agentId: other!.id, name: 'Чужое', kind: 'text', position: 0 })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/lead-fields/${foreign!.id}`,
      cookies: jar,
      payload: { name: 'Взлом' },
    });

    expect(res.statusCode).toBe(404);
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

  describe('order', () => {
    /** Three fields, in the order they were added, as the list route returns them. */
    async function threeFields() {
      for (const [name, kind] of [
        ['Город', 'text'],
        ['Бюджет', 'number'],
        ['Дата', 'date'],
      ] as const) {
        await app.inject({
          method: 'POST',
          url: `/api/agents/${agentId}/lead-fields`,
          cookies: jar,
          payload: { name, kind },
        });
      }
      const list = await app.inject({ url: `/api/agents/${agentId}/lead-fields`, cookies: jar });
      return list.json() as { id: string; name: string }[];
    }

    it('rewrites every position on reorder', async () => {
      const list = await threeFields();
      const ids = [list.at(-1)!.id, ...list.slice(0, -1).map((field) => field.id)];

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/lead-fields/order`,
        cookies: jar,
        payload: { ids },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; position: number }[];
      expect(body.map((field) => field.id)).toEqual(ids);
      expect(body.map((field) => field.position)).toEqual(ids.map((_, i) => i));
    });

    it('refuses an order that does not name every field', async () => {
      const list = await threeFields();

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/lead-fields/order`,
        cookies: jar,
        payload: { ids: list.slice(1).map((field) => field.id) },
      });

      expect(res.statusCode).toBe(400);
    });

    it('refuses an order that names one field twice', async () => {
      const list = await threeFields();

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/lead-fields/order`,
        cookies: jar,
        payload: { ids: [list[0]!.id, ...list.map((field) => field.id)] },
      });

      expect(res.statusCode).toBe(400);
    });

    it("refuses an order carrying another agent's field", async () => {
      const list = await threeFields();
      const [other] = await db
        .insert(agents)
        .values({
          accountId: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.accountId,
          name: 'Другая',
        })
        .returning();
      const [foreign] = await db
        .insert(leadFields)
        .values({ agentId: other!.id, name: 'Чужое', kind: 'text', position: 0 })
        .returning();

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/lead-fields/order`,
        cookies: jar,
        payload: { ids: [foreign!.id, ...list.slice(1).map((field) => field.id)] },
      });

      expect(res.statusCode).toBe(400);
      // The list is untouched: a refused order must not half-apply.
      const after = await app.inject({ url: `/api/agents/${agentId}/lead-fields`, cookies: jar });
      expect((after.json() as { id: string }[]).map((field) => field.id)).toEqual(
        list.map((field) => field.id),
      );
    });

    it('refuses an order from a member', async () => {
      const list = await threeFields();
      const memberJar = await login('member@example.com');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/lead-fields/order`,
        cookies: memberJar,
        payload: { ids: list.map((field) => field.id) },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
