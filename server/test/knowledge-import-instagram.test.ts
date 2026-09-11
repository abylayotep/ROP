import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { kbNotes, kbSources } from '../src/db/schema.js';
import {
  InstagramError,
  type InstagramAccount,
  type InstagramClient,
  type InstagramPost,
} from '../src/lib/instagram/graph.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

/**
 * Импорт постов Instagram в базу знаний.
 *
 * The shop's own words about its goods are what the agent is missing, and they are sitting
 * in captions nobody has retyped. Two properties carry the feature: the import writes the
 * captions as ordinary notes, and pressing it a second time leaves alone every note that is
 * already there — a caption a seller rewrote into something usable must survive the update.
 */

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let jar: Record<string, string>;

const account: InstagramAccount = {
  id: 'ig-1',
  username: 'sealhouse.kz',
  biography: 'Двери из массива. Астана.',
  website: 'https://sealhouse.kz',
  pageName: 'Sealhouse',
};

const post = (over: Partial<InstagramPost> = {}): InstagramPost => ({
  id: 'p1',
  caption: 'Двери из дуба, срок 14 дней',
  permalink: 'https://www.instagram.com/p/p1/',
  timestamp: '2026-03-12T09:00:00+0000',
  mediaType: 'IMAGE',
  ...over,
});

/** An Instagram that answers with what the test set, and counts what was asked of it. */
function fakeInstagram(posts: InstagramPost[], over: Partial<InstagramClient> = {}) {
  const calls: string[] = [];
  const client: InstagramClient = {
    account: async (token) => {
      calls.push(`account:${token}`);
      return account;
    },
    posts: async () => {
      calls.push('posts');
      return posts;
    },
    ...over,
  };
  return { client, calls };
}

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

async function build(instagram: InstagramClient) {
  app = buildServer(env, db, { graph: fakeGraph(), instagram });
  await app.ready();
  jar = await login();
}

const runImport = () =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/instagram`,
    cookies: jar,
    payload: { code: 'code-from-meta' },
  });

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });

  await build(fakeInstagram([post()]).client);
  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Sealhouse' },
  });
  agentId = created.json().id;
});

afterEach(async () => {
  await app.close();
});

describe('importing from Instagram', () => {
  it('writes the captions and the profile as notes', async () => {
    const res = await runImport();

    expect(res.statusCode).toBe(200);
    const paths = res.json().notes.map((note: { path: string }) => note.path);
    expect(paths).toContain('Instagram/@sealhouse.kz/О магазине');
    expect(paths.some((path: string) => path.includes('12 марта 2026'))).toBe(true);

    const [source] = await db.select().from(kbSources);
    expect(source).toMatchObject({
      kind: 'instagram',
      title: '@sealhouse.kz',
      url: 'https://www.instagram.com/sealhouse.kz/',
      status: 'ready',
      itemCount: 2,
    });
  });

  it('keeps the link back to the post in the note', async () => {
    await runImport();

    const rows = await db.select().from(kbNotes);
    const caption = rows.find((row) => row.body.includes('дуба'));
    expect(caption?.body).toContain('https://www.instagram.com/p/p1/');
  });

  it('leaves a post that is already imported exactly as it was', async () => {
    await runImport();
    // The seller rewrote both notes into something the agent can actually answer with.
    await db.update(kbNotes).set({ body: 'Дуб, 14 дней, 120 000 ₸' });

    const second = await runImport();

    expect(second.statusCode).toBe(200);
    expect(second.json().reimported).toBe(true);
    // Nothing new to write: the second pass adds no note and rewrites none.
    expect(second.json().notes).toEqual([]);
    const rows = await db.select().from(kbNotes);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.body === 'Дуб, 14 дней, 120 000 ₸')).toBe(true);
  });

  it('adds only the posts that appeared since the last import', async () => {
    await runImport();

    await build(
      fakeInstagram([
        post(),
        post({ id: 'p2', caption: 'Новая партия ручек', permalink: 'https://www.instagram.com/p/p2/', timestamp: '2026-04-01T09:00:00+0000' }),
      ]).client,
    );
    const second = await runImport();

    expect(second.json().notes).toHaveLength(1);
    expect(second.json().notes[0].path).toContain('1 апреля 2026');
  });

  it('says what Meta refused, in Meta’s own words', async () => {
    await build(
      fakeInstagram([], {
        account: () =>
          Promise.reject(new InstagramError('К этому аккаунту Meta не привязан Instagram.')),
      }).client,
    );

    const res = await runImport();

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('не привязан Instagram');
    expect(await db.select().from(kbSources)).toEqual([]);
  });

  it('refuses an account whose posts carry no words at all', async () => {
    await build(fakeInstagram([post({ caption: null })], {
      account: async () => ({ ...account, biography: null }),
    }).client);

    const res = await runImport();

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('нечего сохранить');
  });

  it('is the owner’s button, not a member’s', async () => {
    const setup = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/knowledge/instagram`,
      cookies: jar,
    });

    expect(setup.statusCode).toBe(200);
    expect(setup.json().appId).toBe(env.META_APP_ID);
  });
});
