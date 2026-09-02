# Task 5: Turning a payload into messages

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

A stored delivery becomes a contact, a conversation and a message. This is where duplicate
deliveries are absorbed and where a payload about somebody else's number is ignored without
being treated as a failure.

Processing is a function over pending events rather than code inside the route: the webhook
schedules it, the tests call it, and a later stage can re-run it over rows that failed.

**Files:**
- Create: `server/src/lib/whatsapp/inbound.ts`
- Modify: `server/src/api/whatsapp-webhook.ts`
- Test: `server/test/whatsapp-inbound.test.ts`

**Interfaces:**
- Consumes: the tables from task 2; `GraphClient` from task 3 (accepted now, used in task 7).
- Produces:
  `processPendingEvents(db: Db, deps: InboundDeps): Promise<{ processed: number; failed: number }>`
  and `InboundDeps { graph: GraphClient; key: Buffer; mediaDir: string }` from
  `server/src/lib/whatsapp/inbound.ts`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp-inbound.test.ts` with the contents given in
[task 5, step 1](2026-09-02-whatsapp-task-5-inbound-test.md) — eleven cases covering
the first message, duplicate delivery, renaming, an unknown number, an unrenderable type,
a status callback, and a payload that cannot be parsed. Copy it verbatim.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-inbound
```

Expected: FAIL — cannot resolve `../src/lib/whatsapp/inbound.js`.

- [ ] **Step 3: Write the processor**

Create `server/src/lib/whatsapp/inbound.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  contacts,
  conversations,
  messages,
  whatsappEvents,
  whatsappNumbers,
} from '../../db/schema.js';
import type { GraphClient } from './graph.js';

/**
 * Turning stored webhook deliveries into rows.
 *
 * A function over pending events rather than code inside the route, for three reasons: the
 * route can answer Meta before any of this runs, the tests can drive it without HTTP, and a
 * delivery that failed to parse can be run again once the bug is fixed.
 */

export interface InboundDeps {
  graph: GraphClient;
  /** Decrypts a number's access token; media downloads need it. */
  key: Buffer;
  mediaDir: string;
}

/** The slice of Meta's payload this stage reads. Everything else is ignored on purpose. */
interface InboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
}

interface StatusUpdate {
  id: string;
  status: string;
}

interface ChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: InboundMessage[];
  statuses?: StatusUpdate[];
}

/** WhatsApp sends seconds; Postgres wants a Date. */
const at = (timestamp: string) => new Date(Number(timestamp) * 1000);

/** The text a message carries, if it carries any. A caption counts. */
function bodyOf(message: InboundMessage): string | null {
  return (
    message.text?.body ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption ??
    null
  );
}

export async function processPendingEvents(
  db: Db,
  deps: InboundDeps,
): Promise<{ processed: number; failed: number }> {
  const pending = await db
    .select()
    .from(whatsappEvents)
    .where(isNull(whatsappEvents.processedAt))
    .orderBy(whatsappEvents.receivedAt);

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      await applyPayload(db, deps, event.payload);
      await db
        .update(whatsappEvents)
        .set({ processedAt: new Date(), error: null })
        .where(eq(whatsappEvents.id, event.id));
      processed += 1;
    } catch (error) {
      // The row keeps its payload and gains a reason. One bad delivery must not stop the
      // queue: the next message in line is someone's live conversation.
      await db
        .update(whatsappEvents)
        .set({ error: error instanceof Error ? error.message : String(error) })
        .where(eq(whatsappEvents.id, event.id));
      failed += 1;
    }
  }

  return { processed, failed };
}

async function applyPayload(db: Db, deps: InboundDeps, payload: unknown): Promise<void> {
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) throw new Error('entry is not an array');

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) throw new Error('changes is not an array');

    for (const change of changes) {
      await applyChange(db, deps, (change as { value?: ChangeValue }).value ?? {});
    }
  }
}

async function applyChange(db: Db, deps: InboundDeps, value: ChangeValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

  // Not an error: one Meta application serves every client, and a delivery about a number
  // we do not host is simply not ours.
  if (!number) return;

  for (const status of value.statuses ?? []) {
    await db
      .update(messages)
      .set({ status: status.status })
      .where(eq(messages.waMessageId, status.id));
  }

  for (const incoming of value.messages ?? []) {
    const profileName = value.contacts?.find((c) => c.wa_id === incoming.from)?.profile?.name;
    const contactId = await upsertContact(db, number.agentId, incoming.from, profileName);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    await storeMessage(db, conversationId, incoming);
    await db
      .update(conversations)
      .set({ lastInboundAt: at(incoming.timestamp), lastMessageAt: at(incoming.timestamp) })
      .where(eq(conversations.id, conversationId));
  }
}

async function upsertContact(
  db: Db,
  agentId: string,
  phone: string,
  name: string | undefined,
): Promise<string> {
  const [created] = await db
    .insert(contacts)
    .values({ agentId, phone, name: name ?? null })
    .onConflictDoUpdate({
      target: [contacts.agentId, contacts.phone],
      // A person who edits their WhatsApp profile should be renamed here too, but a
      // delivery without a name must not erase the one we have.
      set: name ? { name } : { phone },
    })
    .returning({ id: contacts.id });
  return created!.id;
}

async function upsertConversation(
  db: Db,
  agentId: string,
  whatsappNumberId: string,
  contactId: string,
): Promise<string> {
  const [created] = await db
    .insert(conversations)
    .values({ agentId, contactId, whatsappNumberId })
    .onConflictDoUpdate({
      target: [conversations.whatsappNumberId, conversations.contactId],
      set: { contactId },
    })
    .returning({ id: conversations.id });
  return created!.id;
}

async function storeMessage(
  db: Db,
  conversationId: string,
  incoming: InboundMessage,
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      waMessageId: incoming.id,
      direction: 'in',
      author: 'client',
      kind: incoming.type,
      body: bodyOf(incoming),
      sentAt: at(incoming.timestamp),
    })
    // Meta delivers the same message more than once by design. The unique index on
    // wa_message_id is the defence; this clause is how we accept the duplicate quietly.
    .onConflictDoNothing({ target: messages.waMessageId });
}
```

The unused `and` import goes if the compiler flags it — keep the import list to what the file
uses.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm --prefix server test -- whatsapp-inbound
```

Expected: PASS, ten cases.

- [ ] **Step 5: Let the webhook schedule the work**

In `server/src/api/whatsapp-webhook.ts`, accept the dependencies and schedule processing after
answering. Change the signature to
`registerWhatsappWebhook(app: FastifyInstance, db: Db, env: Env, deps: InboundDeps): void`
and, immediately before the `return reply.code(200).send()`, add:

```ts
      // Answer first, work second. Meta retries only on a non-200, and the event is already
      // stored, so nothing is lost if this throws — the row keeps its error for a re-run.
      setImmediate(() => {
        void processPendingEvents(db, deps).catch((error) => {
          app.log.error({ error }, 'whatsapp: processing pending events failed');
        });
      });
```

In `server/src/api/server.ts`, build the dependencies once and pass them:

```ts
  registerWhatsappWebhook(app, db, env, {
    graph: createGraphClient(),
    key: credentialsKey(env),
    mediaDir: env.MEDIA_DIR,
  });
```

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS. The webhook tests from task 4 still pass: scheduling after the answer does not
change what the route returns.

- [ ] **Step 7: Commit**

```bash
git add -A server
git commit -m "Turn stored WhatsApp deliveries into contacts, conversations and messages"
```
