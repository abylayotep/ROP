import { readFile, rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { agents, messages, whatsappEvents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { extensionFor } from '../src/lib/whatsapp/media.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';
import { fakeLinked } from './helpers/fake-linked.js';

const env = testEnv({ MEDIA_DIR: 'var/media-test' });
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

const deps = (graph = fakeGraph()) => ({ graph, linked: fakeLinked(), key, mediaDir: env.MEDIA_DIR, model: fakeModel() });

const photo = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '932',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '77085807932', phone_number_id: '136' },
            contacts: [{ profile: { name: 'Айгерім' }, wa_id: '77771234567' }],
            messages: [
              {
                from: '77771234567',
                id: 'wamid.PHOTO',
                timestamp: '1756000000',
                type: 'image',
                image: { id: 'media-42', mime_type: 'image/jpeg', caption: 'Вот эта модель' },
              },
            ],
          },
        },
      ],
    },
  ],
};

const voice = {
  object: 'whatsapp_business_account',
  entry: [{ id: '932', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '77085807932', phone_number_id: '136' },
    contacts: [{ profile: { name: 'Айгерім' }, wa_id: '77771234567' }],
    messages: [{ from: '77771234567', id: 'wamid.VOICE', timestamp: '1756000000', type: 'audio',
      audio: { id: 'media-voice', mime_type: 'audio/ogg; codecs=opus' } }],
  } }] }],
};

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Сафина' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ openrouterKey: encryptSecret('sk-or-test', key, agentId) }).where(eq(agents.id, agentId));
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret('EAAG-token', key, '136'),
  });
  await db.insert(whatsappEvents).values({ payload: photo });
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

describe('inbound media', () => {
  it('stores a voice-note transcription as message text', async () => {
    await db.delete(whatsappEvents);
    await db.insert(whatsappEvents).values({ payload: voice });
    const model = fakeModel();
    model.transcriptions.push('Мне нужна входная дверь');

    await processPendingEvents(db, { ...deps(fakeGraph({ getMediaUrl: async () => ({
      url: 'https://lookaside.fb/audio', mimeType: 'audio/ogg; codecs=opus', fileSize: 3,
    }) })), model });

    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ kind: 'audio', body: 'Мне нужна входная дверь' });
    expect(model.transcriptionCalls[0]).toMatchObject({ mime: 'audio/ogg; codecs=opus' });
  });

  it('keeps the audio file when transcription fails', async () => {
    await db.delete(whatsappEvents);
    await db.insert(whatsappEvents).values({ payload: voice });
    const model = fakeModel();
    model.transcriptions.push(new Error('speech service unavailable'));

    await processPendingEvents(db, { ...deps(fakeGraph({ getMediaUrl: async () => ({
      url: 'https://lookaside.fb/audio', mimeType: 'audio/ogg; codecs=opus', fileSize: 3,
    }) })), model });

    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ kind: 'audio', body: null, mediaMime: 'audio/ogg; codecs=opus' });
    expect(message!.mediaPath).not.toBeNull();
    const [event] = await db.select().from(whatsappEvents);
    expect(event!.error).toContain('speech service unavailable');
  });

  it('downloads the file and remembers where it went', async () => {
    const graph = fakeGraph();

    await processPendingEvents(db, deps(graph));

    const [message] = await db.select().from(messages);
    expect(message!.kind).toBe('image');
    expect(message!.body).toBe('Вот эта модель');
    expect(message!.mediaMime).toBe('image/jpeg');
    expect(message!.mediaPath).toMatch(new RegExp(`^${agentId}/.+\\.jpg$`));
    expect([...(await readFile(`${env.MEDIA_DIR}/${message!.mediaPath}`))]).toEqual([1, 2, 3]);
  });

  it('sends Meta the token stored for that number, decrypted', async () => {
    const graph = fakeGraph();

    await processPendingEvents(db, deps(graph));

    expect(graph.calls.map((c) => c.method)).toEqual(['getMediaUrl', 'downloadMedia']);
    expect(graph.calls[0]!.args[1]).toBe('EAAG-token');
    expect(graph.calls[1]!.args[1]).toBe('EAAG-token');
  });

  it('keeps the message when the file cannot be fetched', async () => {
    const graph = fakeGraph({
      getMediaUrl: async () => {
        throw new GraphError('Media not found', 404, 100);
      },
    });

    const result = await processPendingEvents(db, deps(graph));

    expect(result).toEqual({ processed: 1, failed: 0 });
    const [message] = await db.select().from(messages);
    expect(message!.kind).toBe('image');
    expect(message!.mediaPath).toBeNull();
    const [event] = await db.select().from(whatsappEvents);
    expect(event!.error).toContain('Media not found');
    expect(event!.processedAt).toBeInstanceOf(Date);
  });

  it('does not store the decrypted token when a media download fails', async () => {
    const graph = fakeGraph({
      getMediaUrl: async () => {
        throw new GraphError('Malformed access token EAAG-token', 401, 190);
      },
    });

    await processPendingEvents(db, deps(graph));

    const [event] = await db.select().from(whatsappEvents);
    expect(event!.error).not.toContain('EAAG-token');
    expect(event!.error).toContain('<токен скрыт>');
  });

  it('processes the rest of the delivery when a number\'s token cannot be decrypted', async () => {
    // A key that no longer matches the one this token was sealed with — rotated, or a
    // row someone edited by hand. `decryptSecret` throws in that case, and that must
    // cost this message its file, not the whole delivery.
    await db
      .update(whatsappNumbers)
      .set({ accessToken: 'not-encrypted-at-all' })
      .where(eq(whatsappNumbers.phoneNumberId, '136'));
    const graph = fakeGraph();

    const result = await processPendingEvents(db, deps(graph));

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(graph.calls).toEqual([]);
    const [message] = await db.select().from(messages);
    expect(message!.kind).toBe('image');
    expect(message!.body).toBe('Вот эта модель');
    expect(message!.mediaPath).toBeNull();
    const [event] = await db.select().from(whatsappEvents);
    expect(event!.processedAt).toBeInstanceOf(Date);
    expect(event!.error).toBeTruthy();
  });

  it('refuses a file larger than the cap without downloading it', async () => {
    const graph = fakeGraph({
      getMediaUrl: async () => ({
        url: 'https://lookaside.fb/big',
        mimeType: 'video/mp4',
        fileSize: 30 * 1024 * 1024,
      }),
    });

    await processPendingEvents(db, deps(graph));

    expect(graph.calls.map((c) => c.method)).toEqual(['getMediaUrl']);
    expect((await db.select().from(messages))[0]!.mediaPath).toBeNull();
  });

  it('names the file by what it is, not by what it claims', () => {
    expect(extensionFor('image/jpeg')).toBe('.jpg');
    expect(extensionFor('image/png')).toBe('.png');
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('.ogg');
    expect(extensionFor('application/pdf')).toBe('.pdf');
    expect(extensionFor('application/vnd.made-up')).toBe('.bin');
  });
});
