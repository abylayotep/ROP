# Task 7: Media

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Clients send photographs constantly — of the product they want, of a payment receipt, of an
address. An inbound media message carries an id, not a file, and Meta's download URL expires in
minutes while the file itself is deleted after thirty days. Fetching on demand therefore means
showing a broken image to anyone who scrolls up, so the file is fetched the moment the message
is processed.

**Files:**
- Create: `server/src/lib/whatsapp/media.ts`
- Modify: `server/src/lib/whatsapp/inbound.ts`
- Test: `server/test/whatsapp-media.test.ts`

**Interfaces:**
- Consumes: `GraphClient` and `fakeGraph` from task 3; `decryptSecret` from task 1;
  `processPendingEvents` from task 5.
- Produces: `downloadInboundMedia(deps, params): Promise<{ path: string; mime: string }>` and
  `extensionFor(mime: string): string` from `server/src/lib/whatsapp/media.ts`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp-media.test.ts`:

```ts
import { readFile, rm } from 'node:fs/promises';
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

const env = testEnv({ MEDIA_DIR: 'var/media-test' });
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

const deps = (graph = fakeGraph()) => ({ graph, key, mediaDir: env.MEDIA_DIR });

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
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret('EAAG-token', key),
  });
  await db.insert(whatsappEvents).values({ payload: photo });
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

describe('inbound media', () => {
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-media
```

Expected: FAIL — cannot resolve `../src/lib/whatsapp/media.js`.

- [ ] **Step 3: Write the downloader**

Create `server/src/lib/whatsapp/media.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GraphClient } from './graph.js';

/**
 * Fetching a file a client sent.
 *
 * WhatsApp hands over an id, not bytes. The URL behind it lives for minutes and the file for
 * thirty days, so it is fetched when the message arrives rather than when someone opens the
 * conversation — otherwise scrolling back a month shows a broken image.
 */

/** Comfortably above WhatsApp's own limit for every type it accepts. */
const MAX_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

/**
 * The extension for a mime type, ignoring parameters — WhatsApp sends voice notes as
 * `audio/ogg; codecs=opus`, and the part after the semicolon is not part of the type.
 */
export function extensionFor(mime: string): string {
  return EXTENSIONS[mime.split(';')[0]!.trim().toLowerCase()] ?? '.bin';
}

export interface DownloadParams {
  mediaId: string;
  /** Already decrypted. This function does no key handling. */
  token: string;
  agentId: string;
  waMessageId: string;
}

export async function downloadInboundMedia(
  deps: { graph: GraphClient; mediaDir: string },
  params: DownloadParams,
): Promise<{ path: string; mime: string }> {
  const descriptor = await deps.graph.getMediaUrl(params.mediaId, params.token);

  if (descriptor.fileSize > MAX_BYTES) {
    throw new Error(`Media ${params.mediaId} is ${descriptor.fileSize} bytes, over the limit`);
  }

  const bytes = await deps.graph.downloadMedia(descriptor.url, params.token);

  // Grouped by agent so one client's files can be moved or removed on their own, and named
  // by the WhatsApp message id, which is unique and already stored on the row.
  const relative = join(
    params.agentId,
    `${params.waMessageId.replace(/[^\w.-]/g, '_')}${extensionFor(descriptor.mimeType)}`,
  );
  const absolute = join(deps.mediaDir, relative);

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);

  return { path: relative, mime: descriptor.mimeType };
}
```

- [ ] **Step 4: Fetch it while processing**

In `server/src/lib/whatsapp/inbound.ts`:

Add the media id reader beside `bodyOf`:

```ts
/** The media id a message carries, if it carries one. */
function mediaIdOf(message: InboundMessage): string | null {
  return (
    message.image?.id ??
    message.audio?.id ??
    message.video?.id ??
    message.document?.id ??
    message.sticker?.id ??
    null
  );
}
```

Give `storeMessage` the media it should record by changing its signature to accept
`media: { path: string; mime: string } | null` and adding
`mediaPath: media?.path ?? null, mediaMime: media?.mime ?? null` to the inserted values.

In `applyChange`, before storing, fetch when there is something to fetch:

```ts
    const mediaId = mediaIdOf(incoming);
    const media = mediaId
      ? await downloadInboundMedia(deps, {
          mediaId,
          token: decryptSecret(number.accessToken, deps.key),
          agentId: number.agentId,
          waMessageId: incoming.id,
        })
      : null;
```

A failed download must not lose the message. Wrap that call so the text survives and the reason
is recorded on the event:

```ts
    let media: { path: string; mime: string } | null = null;
    let mediaError: string | null = null;
    const mediaId = mediaIdOf(incoming);
    if (mediaId) {
      try {
        media = await downloadInboundMedia(deps, {
          mediaId,
          token: decryptSecret(number.accessToken, deps.key),
          agentId: number.agentId,
          waMessageId: incoming.id,
        });
      } catch (error) {
        // The message is still worth having: its caption, its sender and its place in the
        // thread are all real. Only the file is missing, and the event says why.
        mediaError = error instanceof Error ? error.message : String(error);
      }
    }
```

`processPendingEvents` marks the event processed but keeps the reason. Make `applyPayload`
return the collected media errors, and in `processPendingEvents` write them:

```ts
      const mediaErrors = await applyPayload(db, deps, event.payload);
      await db
        .update(whatsappEvents)
        .set({ processedAt: new Date(), error: mediaErrors.length ? mediaErrors.join('; ') : null })
        .where(eq(whatsappEvents.id, event.id));
```

Thread the array through `applyPayload` and `applyChange` — each returns the errors it
collected, and the caller concatenates them.

- [ ] **Step 5: Run it and watch it pass**

```bash
npm --prefix server test -- whatsapp-media
```

Expected: PASS, five cases.

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS. Tasks 5 and 6 still pass: a text message has no media id, so nothing is fetched
and no error is collected.

- [ ] **Step 7: Commit**

```bash
git add -A server
git commit -m "Download inbound WhatsApp media when the message arrives"
```
