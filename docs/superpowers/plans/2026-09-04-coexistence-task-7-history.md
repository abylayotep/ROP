# Task 7: Webhook — history import

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 6.

**Files:**
- Create: `server/src/lib/whatsapp/history.ts`
- Modify: `server/src/lib/whatsapp/inbound.ts` (one `case 'history'`)
- Test: `server/test/whatsapp-history.test.ts` (new)

**Interfaces:**
- Consumes: `NumberRow`, `digits`, `at`, `bodyOf` from `inbound.ts` — export `digits` and `at`; `bodyOf` too, since history messages share the inbound shape.
- Produces: `applyHistory(db, number: NumberRow, value: HistoryValue): Promise<{ stored: number }>`.

- [ ] **Step 1: Failing tests**

Create `server/test/whatsapp-history.test.ts`. Reuse the `beforeEach` from Task 6's test file verbatim (same seed: a coexistence number `136` on WABA `932`), the `change` and `meta` helpers, and `store`. Then:

```ts
const history = (
  chunks: { phase: number; chunk_order: number; progress: number; threads: unknown[] }[],
) =>
  change('history', {
    ...meta,
    history: chunks.map(({ threads, ...metadata }) => ({ metadata, threads })),
  });

const thread = (id: string, msgs: Record<string, unknown>[]) => ({ id, messages: msgs });

const inbound = (id: string, body: string, ts: string) => ({
  from: '77771234567',
  id,
  timestamp: ts,
  type: 'text',
  text: { body },
  history_context: { status: 'READ' },
});

const outbound = (id: string, body: string, ts: string) => ({
  from: '77715230342',
  to: '77771234567',
  id,
  timestamp: ts,
  type: 'text',
  text: { body },
  history_context: { status: 'DELIVERED' },
});

describe('history import', () => {
  it('stores a thread with both directions, moves last_message_at, opens no window, runs no turn', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 40, threads: [
      thread('77771234567', [inbound('wamid.H1', 'Здравствуйте', '1750000000'), outbound('wamid.H2', 'Добрый день', '1750000060')]),
    ] }]));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const rows = await db.select().from(messages).orderBy(messages.sentAt);
    expect(rows.map((m) => [m.waMessageId, m.direction, m.author, m.status])).toEqual([
      ['wamid.H1', 'in', 'client', null],
      ['wamid.H2', 'out', 'phone', 'delivered'],
    ]);
    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).toBeNull();
    expect(conversation!.lastMessageAt?.toISOString()).toBe('2025-06-15T15:21:00.000Z');
    expect(conversation!.aiEnabled).toBe(true);
    expect(model.calls).toHaveLength(0);
    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.historyProgress).toBe(40);
  });

  it('accepts chunks out of order and a redelivered chunk adds nothing', async () => {
    const second = history([{ phase: 1, chunk_order: 2, progress: 100, threads: [thread('77771234567', [inbound('wamid.H3', 'Спасибо', '1740000000')])] }]);
    const first = history([{ phase: 1, chunk_order: 1, progress: 70, threads: [thread('77771234567', [inbound('wamid.H1', 'Здравствуйте', '1750000000')])] }]);
    await store(second);
    await store(first);
    await store(second);

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(2);
    const [number] = await db.select().from(whatsappNumbers);
    // Progress only grows: the 70 that arrived after the 100 must not pull it back.
    expect(number!.historyProgress).toBe(100);
  });

  it('stores a media placeholder as an unsupported message with an explanation', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 100, threads: [thread('77771234567', [
      { from: '77771234567', id: 'wamid.M1', timestamp: '1750000000', type: 'media_placeholder', history_context: { status: 'READ' } },
    ])] }]));

    await processPendingEvents(db, deps());

    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ kind: 'unsupported', body: 'Файл из истории телефона', mediaPath: null });
  });

  it('records that the owner declined history sharing', async () => {
    await store(change('history', {
      ...meta,
      history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App', message: 'History sync is turned off by the business from the WhatsApp Business App' }] }],
    }));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.historyDeclinedAt).not.toBeNull();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('ignores a thread whose id is not a phone', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 100, threads: [thread('120363012345678901@g.us', [inbound('wamid.G1', 'group', '1750000000')])] }]));

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(0);
  });
});
```

The `1750000060` → `2025-06-15T15:21:00.000Z` expectation assumes UTC arithmetic; compute with `new Date(1750000060 * 1000).toISOString()` if the literal disagrees.

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- whatsapp-history` → nothing stored (unknown field falls through).

- [ ] **Step 3: The importer**

Create `server/src/lib/whatsapp/history.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, messages, whatsappNumbers } from '../../db/schema.js';

/** Meta's error code for «the business turned history sharing off on the phone». */
const HISTORY_DECLINED = 2593109;
/** Rows per insert. A chunk can describe thousands of messages; one statement each is slow. */
const BATCH = 500;

interface HistoryMessage {
  from: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  history_context?: { status?: string };
}

interface HistoryChunk {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id: string; messages?: HistoryMessage[] }[];
  errors?: { code?: number; message?: string }[];
}

export interface HistoryValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  history?: HistoryChunk[];
}

type NumberRow = typeof whatsappNumbers.$inferSelect;

const digits = (s: string) => s.replace(/\D/g, '');
const at = (timestamp: string) => new Date(Number(timestamp) * 1000);

/** Threads are keyed by the customer's number. A group id carries `@g.us` and is not one. */
const isPhone = (id: string) => /^\d{7,15}$/.test(id);

function bodyOf(m: HistoryMessage): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'image':
      return m.image?.caption ?? null;
    case 'video':
      return m.video?.caption ?? null;
    case 'document':
      return m.document?.caption ?? m.document?.filename ?? null;
    case 'media_placeholder':
      return 'Файл из истории телефона';
    default:
      return null;
  }
}

/**
 * One `history` webhook: up to 180 days of the phone's chats, in chunks that may arrive in
 * any order and more than once.
 *
 * Everything written here is idempotent — the unique index on `wa_message_id` drops a
 * repeat, the upserts are conflict-safe, the timestamps only move forward — which is what
 * makes order and redelivery irrelevant. Imported messages move `last_message_at` so the
 * thread sorts where it belongs, and never `last_inbound_at`: an old message opens no reply
 * window, wakes no agent and enters no funnel. The customer's next real message does all of
 * that in the usual way.
 */
export async function applyHistory(
  db: Db,
  number: NumberRow,
  value: HistoryValue,
): Promise<{ stored: number }> {
  let stored = 0;
  let progress = number.historyProgress;

  for (const chunk of value.history ?? []) {
    if (chunk.errors?.some((e) => e.code === HISTORY_DECLINED)) {
      await db
        .update(whatsappNumbers)
        .set({ historyDeclinedAt: sql`coalesce(${whatsappNumbers.historyDeclinedAt}, now())` })
        .where(eq(whatsappNumbers.id, number.id));
      continue;
    }
    progress = Math.max(progress, chunk.metadata?.progress ?? 0);

    for (const thread of chunk.threads ?? []) {
      const phone = digits(thread.id);
      if (!isPhone(phone)) continue;
      const list = thread.messages ?? [];
      if (list.length === 0) continue;

      const [contact] = await db
        .insert(contacts)
        .values({ agentId: number.agentId, phone })
        .onConflictDoUpdate({ target: [contacts.agentId, contacts.phone], set: { phone } })
        .returning({ id: contacts.id });
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId: number.agentId, contactId: contact!.id, whatsappNumberId: number.id })
        .onConflictDoUpdate({
          target: [conversations.whatsappNumberId, conversations.contactId],
          set: { contactId: contact!.id },
        })
        .returning({ id: conversations.id });

      const business = digits(number.displayPhone);
      let latest = 0;
      for (let i = 0; i < list.length; i += BATCH) {
        const rows = list.slice(i, i + BATCH).map((m) => {
          const outbound = digits(m.from) === business;
          const sentAt = at(m.timestamp);
          latest = Math.max(latest, sentAt.getTime());
          return {
            conversationId: conversation!.id,
            waMessageId: m.id,
            direction: outbound ? 'out' : 'in',
            author: outbound ? 'phone' : 'client',
            kind: m.type === 'media_placeholder' ? 'unsupported' : m.type,
            body: bodyOf(m),
            status: outbound ? (m.history_context?.status?.toLowerCase() ?? null) : null,
            sentAt,
          };
        });
        const inserted = await db
          .insert(messages)
          .values(rows)
          .onConflictDoNothing({ target: messages.waMessageId })
          .returning({ id: messages.id });
        stored += inserted.length;
      }

      if (latest > 0) {
        const latestParam = sql`${new Date(latest).toISOString()}::timestamptz`;
        await db
          .update(conversations)
          .set({ lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${latestParam})` })
          .where(eq(conversations.id, conversation!.id));
      }
    }
  }

  if (progress > number.historyProgress) {
    await db
      .update(whatsappNumbers)
      .set({ historyProgress: sql`greatest(${whatsappNumbers.historyProgress}, ${progress})` })
      .where(eq(whatsappNumbers.id, number.id));
  }
  return { stored };
}
```

Wire it in `inbound.ts`'s `switch`:

```ts
    case 'history':
      await applyHistory(db, number, value as HistoryValue);
      return [];
```

with `import { applyHistory, type HistoryValue } from './history.js';`. `ChangeValue` and `HistoryValue` overlap on `metadata`, so the cast is honest.

Follow-up media for a placeholder (the second `history` webhook with the real asset, ≤14 days old) is stored as a new message only if its `wa_message_id` differs; if Meta reuses the id, the unique index drops it and the placeholder stays. That is acceptable for this stage and noted in the docs task.

- [ ] **Step 4: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/whatsapp/history.ts server/src/lib/whatsapp/inbound.ts server/test/whatsapp-history.test.ts
git commit -m "Import the phone's chat history into the cabinet"
```
