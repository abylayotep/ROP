import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, messages, whatsappEvents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;
let model: FakeModel;

const deps = () => ({ graph: fakeGraph(), key, mediaDir: env.MEDIA_DIR, model });

beforeEach(async () => {
  db = await withDb();
  model = fakeModel();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: '932',
      displayPhone: '+7 771 523 03 42',
      accessToken: encryptSecret('EAAB-token', key, '136'),
      connectionKind: 'coexistence',
    })
    .returning();
  numberId = number!.id;
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

/** One delivery of one change, in the envelope Meta uses for every field. */
const change = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '932', changes: [{ field, value }] }],
});

const meta = { messaging_product: 'whatsapp', metadata: { display_phone_number: '77715230342', phone_number_id: '136' } };

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });

const echo = (id = 'wamid.ECHO', body = 'Доставим завтра') =>
  change('smb_message_echoes', {
    ...meta,
    message_echoes: [{ from: '77715230342', to: '77771234567', id, timestamp: '1756000100', type: 'text', text: { body } }],
  });

describe('a message the operator sent from the phone', () => {
  it('is stored as an outbound message by the phone and silences the AI on that thread', async () => {
    await store(echo());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ agentId, phone: '77771234567' });
    const [conversation] = await db.select().from(conversations);
    expect(conversation).toMatchObject({ whatsappNumberId: numberId, aiEnabled: false, lastInboundAt: null });
    expect(conversation!.lastMessageAt?.toISOString()).toBe('2025-08-24T01:48:20.000Z');
    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ waMessageId: 'wamid.ECHO', direction: 'out', author: 'phone', kind: 'text', body: 'Доставим завтра', status: 'sent' });
    expect(model.calls).toHaveLength(0);
  });

  it('is stored once when delivered twice', async () => {
    await store(echo());
    await store(echo());

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('does not silence the AI again when the same echo is redelivered', async () => {
    await store(echo());
    await processPendingEvents(db, deps());

    // The operator handed the thread back to the agent in the cabinet.
    await db.update(conversations).set({ aiEnabled: true });

    await store(echo());
    await processPendingEvents(db, deps());

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.aiEnabled).toBe(true);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('does not open a reply window', async () => {
    await store(echo());
    await processPendingEvents(db, deps());

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).toBeNull();
  });
});

describe('contacts synced from the phone', () => {
  const sync = (action: 'add' | 'remove', name?: string) =>
    change('smb_app_state_sync', {
      ...meta,
      state_sync: [
        {
          type: 'contact',
          contact: name ? { full_name: name, first_name: name.split(' ')[0], phone_number: '+7 777 123 45 67' } : { phone_number: '+7 777 123 45 67' },
          action,
          metadata: { timestamp: '1756000200' },
        },
      ],
    });

  it('creates a contact with the phone-book name', async () => {
    await store(sync('add', 'Айгерім Клиент'));

    await processPendingEvents(db, deps());

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ phone: '77771234567', name: 'Айгерім Клиент' });
    expect(await db.select().from(conversations)).toHaveLength(0);
  });

  it('does not overwrite a name the cabinet already holds', async () => {
    await db.insert(contacts).values({ agentId, phone: '77771234567', name: 'Айгерім (оптовик)' });
    await store(sync('add', 'Айгерім Клиент'));

    await processPendingEvents(db, deps());

    const [contact] = await db.select().from(contacts).where(eq(contacts.phone, '77771234567'));
    expect(contact!.name).toBe('Айгерім (оптовик)');
  });

  it('keeps the contact when the phone removes it', async () => {
    await db.insert(contacts).values({ agentId, phone: '77771234567', name: 'Айгерім' });
    await store(sync('remove'));

    await processPendingEvents(db, deps());

    expect(await db.select().from(contacts)).toHaveLength(1);
  });
});
