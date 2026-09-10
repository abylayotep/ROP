import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeFetcher, type FakeFetcher } from './helpers/fake-fetcher.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';
/** The one address the page-import tests fetch. What varies is what answers at it. */
const PAGE_URL = 'https://safina.kz/';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let jar: Record<string, string>;
let fetcher: FakeFetcher;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** Rebuilds the server with a different fetcher, the way `knowledge-page.test.ts` does. */
function setFetcher(next: FakeFetcher) {
  fetcher = next;
  app = buildServer(env, db, { graph: fakeGraph(), pageFetcher: fetcher });
}

const notes = () => `/api/agents/${agentId}/knowledge/notes`;
const rules = () => `/api/agents/${agentId}/rules`;
const sources = () => `/api/agents/${agentId}/knowledge/sources`;
const aiSettings = () => `/api/agents/${agentId}/ai`;
const agent = () => `/api/agents/${agentId}`;
const stages = () => `/api/agents/${agentId}/stages`;
const leadFields = () => `/api/agents/${agentId}/lead-fields`;

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  app = buildServer(env, db, { graph: fakeGraph(), pageFetcher: fakeFetcher({}) });
  await app.ready();
  jar = await login();

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;
});

afterEach(async () => {
  await app.close();
});

/** Reads this agent's current `config_version` straight from the row. */
const version = async () =>
  (await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.v;

/** Serves `html` at `PAGE_URL` and imports it. */
const importPage = (html: string) => {
  setFetcher(fakeFetcher({ [PAGE_URL]: html }));
  return app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/page`,
    cookies: jar,
    payload: { url: PAGE_URL },
  });
};

/** The one source these page tests keep. */
async function currentSourceId(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: sources(), cookies: jar });
  return res.json()[0].id;
}

const reimportSource = (sourceId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/sources/${sourceId}/reimport`,
    cookies: jar,
  });

describe('config version', () => {
  it('moves when a note is written, renamed or deleted', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'POST',
      url: notes(),
      cookies: jar,
      payload: { path: 'Доставка', body: '1500 ₸.' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);

    await app.inject({
      method: 'PATCH',
      url: `${notes()}/${res.json().id}`,
      cookies: jar,
      payload: { body: '1600 ₸.' },
    });
    expect(await version()).toBe(before + 2);

    await app.inject({ method: 'DELETE', url: `${notes()}/${res.json().id}`, cookies: jar });
    expect(await version()).toBe(before + 3);
  });

  it('moves when a rule is created, edited, switched or deleted', async () => {
    const before = await version();

    const created = await app.inject({
      method: 'POST',
      url: rules(),
      cookies: jar,
      payload: { category: 'tone', text: 'На «вы».' },
    });
    expect(created.statusCode).toBe(200);
    const rule = created.json();
    expect(await version()).toBe(before + 1);

    await app.inject({
      method: 'PATCH',
      url: `${rules()}/${rule.id}`,
      cookies: jar,
      payload: { text: 'Только на «вы».' },
    });
    expect(await version()).toBe(before + 2);

    await app.inject({
      method: 'PATCH',
      url: `${rules()}/${rule.id}`,
      cookies: jar,
      payload: { enabled: false },
    });
    expect(await version()).toBe(before + 3);

    await app.inject({ method: 'DELETE', url: `${rules()}/${rule.id}`, cookies: jar });
    expect(await version()).toBe(before + 4);
  });

  it('moves when a page is imported and when it is reimported', async () => {
    const before = await version();

    const imported = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
    expect(imported.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);

    const res = await reimportSource(imported.json().source.id);
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 2);
  });

  it('does not move on a read', async () => {
    await app.inject({
      method: 'POST',
      url: notes(),
      cookies: jar,
      payload: { path: 'Доставка', body: '1500 ₸.' },
    });
    const before = await version();

    await app.inject({ method: 'GET', url: notes(), cookies: jar });
    await app.inject({ method: 'GET', url: `${notes()}?q=доставка`, cookies: jar });
    await app.inject({ method: 'GET', url: rules(), cookies: jar });
    await app.inject({ method: 'GET', url: sources(), cookies: jar });

    expect(await version()).toBe(before);
  });

  // A writer the brief's four named tests don't reach: pasting text is a second, separate
  // import path from importing a page, with its own transaction (`storeTextImport`).
  it('moves when text is pasted and imported', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: jar,
      payload: { title: 'Прайс', kind: 'other', text: 'Двери 80 000 ₸.' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  // The PATCH route has three separate write branches (plain field change, same-category
  // reorder, cross-category move) with three separate `return` statements — a bump wired
  // into only one of them would pass the "switched" case above and still miss this one.
  it('moves when a rule is reordered within its category', async () => {
    const first = (
      await app.inject({ method: 'POST', url: rules(), cookies: jar, payload: { category: 'tone', text: 'Раз.' } })
    ).json();
    await app.inject({ method: 'POST', url: rules(), cookies: jar, payload: { category: 'tone', text: 'Два.' } });
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: `${rules()}/${first.id}`,
      cookies: jar,
      payload: { position: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it('moves when a rule is moved to another category', async () => {
    const rule = (
      await app.inject({ method: 'POST', url: rules(), cookies: jar, payload: { category: 'tone', text: 'Раз.' } })
    ).json();
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: `${rules()}/${rule.id}`,
      cookies: jar,
      payload: { category: 'order' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  // Deleting a source clears `kb_notes.source_id` (the FK's `on delete set null`) but leaves
  // every note's body — and so every chunk the agent's prompt actually reads — untouched.
  // Nothing the agent would say changes, so this deliberately does not bump; see the report.
  it('does not move when a source is deleted, only its notes unlinked', async () => {
    const imported = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
    const before = await version();

    const res = await app.inject({
      method: 'DELETE',
      url: `${sources()}/${imported.json().source.id}`,
      cookies: jar,
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before);
  });

  // A failed fetch writes the source's `status`/`error` for the owner to see, but touches no
  // note and no chunk — nothing the agent would say changes, so this deliberately does not
  // bump either.
  it('does not move when a page import or reimport fails', async () => {
    const imported = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
    const before = await version();

    setFetcher(fakeFetcher({ [PAGE_URL]: new Error('HTTP 500') }));
    const res = await reimportSource(imported.json().source.id);
    expect(res.statusCode).toBe(502);
    expect(await version()).toBe(before);
  });

  // Four owner-facing settings feed the prompt (or, for temperature, the sampling call) the
  // same way a knowledge note or a rule does — each is checked one at a time so a bump wired
  // into only one field of the route can't hide behind the others passing.
  it('moves when temperature is changed', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: aiSettings(),
      cookies: jar,
      payload: { temperature: 0.9 },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it('moves when replyLanguage is changed', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: aiSettings(),
      cookies: jar,
      payload: { replyLanguage: 'русский' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it('moves when the agent name is changed', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: agent(),
      cookies: jar,
      payload: { name: 'Сафина Двери' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it('moves when the timezone is changed', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: agent(),
      cookies: jar,
      payload: { timezone: 'Asia/Yekaterinburg' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  // `description` is the one field `patch` on `agents.ts` accepts that never reaches the
  // prompt (see `PromptAgent` in `prompt.ts`) — pinned separately so its exclusion reads as
  // deliberate rather than a field the route forgot to wire up.
  it('does not move when the description is changed', async () => {
    const before = await version();

    const res = await app.inject({
      method: 'PATCH',
      url: agent(),
      cookies: jar,
      payload: { description: 'Продажа дверей и фурнитуры.' },
    });
    expect(res.statusCode).toBe(200);
    expect(await version()).toBe(before);
  });

  // `stagesSection` (`lib/ai/prompt.ts`) writes every stage's name and description into the
  // system prompt — the same failure Task 5 fixed for the agent's own name and timezone, this
  // time for the eight writing routes in `api/stages.ts`. Each checked one at a time so a
  // bump wired into only one route can't hide behind the others passing.
  it('moves when a stage is created, edited, reordered or deleted', async () => {
    const before = await version();

    const created = await app.inject({
      method: 'POST',
      url: stages(),
      cookies: jar,
      payload: { name: 'Новая стадия', color: '#4b8ef0', kind: 'active' },
    });
    expect(created.statusCode).toBe(200);
    const stage = created.json();
    expect(await version()).toBe(before + 1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `${stages()}/${stage.id}`,
      cookies: jar,
      payload: { description: 'Ждём ответа клиента.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(await version()).toBe(before + 2);

    const all = (await app.inject({ method: 'GET', url: stages(), cookies: jar })).json() as { id: string }[];
    const reordered = await app.inject({
      method: 'POST',
      url: `${stages()}/order`,
      cookies: jar,
      payload: { ids: [...all].reverse().map((s) => s.id) },
    });
    expect(reordered.statusCode).toBe(200);
    expect(await version()).toBe(before + 3);

    const deleted = await app.inject({ method: 'DELETE', url: `${stages()}/${stage.id}`, cookies: jar });
    expect(deleted.statusCode).toBe(200);
    expect(await version()).toBe(before + 4);
  });

  // `fieldsSection` writes every field's name and hint into the prompt the same way
  // `stagesSection` writes a stage — the four lead-field routes get the same treatment.
  it('moves when a lead field is created, edited, reordered or deleted', async () => {
    const before = await version();

    const created = await app.inject({
      method: 'POST',
      url: leadFields(),
      cookies: jar,
      payload: { name: 'Город', kind: 'text', hint: 'В каком городе клиент.' },
    });
    expect(created.statusCode).toBe(200);
    const field = created.json();
    expect(await version()).toBe(before + 1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `${leadFields()}/${field.id}`,
      cookies: jar,
      payload: { hint: 'Город доставки.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(await version()).toBe(before + 2);

    const second = (
      await app.inject({
        method: 'POST',
        url: leadFields(),
        cookies: jar,
        payload: { name: 'Срок', kind: 'text', hint: 'Когда нужно.' },
      })
    ).json();
    expect(await version()).toBe(before + 3);

    const reordered = await app.inject({
      method: 'POST',
      url: `${leadFields()}/order`,
      cookies: jar,
      payload: { ids: [second.id, field.id] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(await version()).toBe(before + 4);

    const deleted = await app.inject({ method: 'DELETE', url: `${leadFields()}/${field.id}`, cookies: jar });
    expect(deleted.statusCode).toBe(200);
    expect(await version()).toBe(before + 5);
  });
});
