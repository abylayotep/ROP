# Task 9: Conversations over the API

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Reading a thread, answering it, and serving the files that arrived in it. The rule that shapes
this task is WhatsApp's own: a business may write freely for 24 hours after the customer's last
message, and not a minute longer without an approved template.

**Files:**
- Create: `server/src/api/conversations.ts`
- Modify: `server/src/api/server.ts`, `packages/contract/index.ts`
- Test: `server/test/conversations.test.ts`

**Interfaces:**
- Consumes: `requireAgent`; `GraphClient`; `decryptSecret`; the tables from task 2.
- Produces: contract types `ConversationSummary`, `Message`, `ConversationThread`; routes
  `GET /api/agents/:agentId/conversations`,
  `GET /api/agents/:agentId/conversations/:conversationId`,
  `POST /api/agents/:agentId/conversations/:conversationId/messages`,
  `GET /api/agents/:agentId/messages/:messageId/media`.

---

- [ ] **Step 1: Add the contract types**

In `packages/contract/index.ts`, below the WhatsApp block:

```ts
export interface Message {
  id: string;
  /** 'in' | 'out' */
  direction: string;
  /** 'client' | 'operator' | 'ai' */
  author: string;
  /** WhatsApp's own type: text, image, audio, video, document, sticker, location, … */
  kind: string;
  body: string | null;
  /** True when a file is stored for this message and can be fetched. */
  hasMedia: boolean;
  mediaMime: string | null;
  /** Outbound only: sent, delivered, read, failed. */
  status: string | null;
  sentAt: string;
}

export interface ConversationSummary {
  id: string;
  contactName: string | null;
  contactPhone: string;
  lastMessageAt: string | null;
  /** The last line, for the list. */
  preview: string | null;
  /** Whether a free-form reply is still allowed. */
  windowOpen: boolean;
  /** Null when the conversation did not come from an ad. */
  adHeadline: string | null;
}

export interface ConversationThread extends ConversationSummary {
  messages: Message[];
}
```

`hasMedia` rather than a path: the browser is told that a file exists and given a route to ask
for it, never a location on our disk.

- [ ] **Step 2: Write the failing test**

Create `server/test/conversations.test.ts` with the contents given in
[task 9, step 2](2026-09-02-whatsapp-task-9-conversations-test.md) — eighteen cases covering the
list, the thread, the 24-hour window, sending, Meta refusing, a disabled number, and media.
Copy it verbatim.

- [ ] **Step 3: Run it and watch it fail**

```bash
npm --prefix server test -- conversations
```

Expected: FAIL — the routes do not exist.

- [ ] **Step 4: Write the routes**

Create `server/src/api/conversations.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationSummary, ConversationThread, Message } from '@rakurs/contract';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { contacts, conversations, messages, whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, decryptSecret } from '../lib/secret-box.js';
import { GraphError, type GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';

/** WhatsApp allows a free-form reply for 24 hours after the customer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One rule, one place. The list, the thread and the send route all have to agree about
 * whether an operator may still write, and three copies of this would eventually disagree.
 */
export const windowOpen = (lastInboundAt: Date | null, now = new Date()): boolean =>
  lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;

const outgoing = z.object({ body: z.string() });

const toMessage = (row: typeof messages.$inferSelect): Message => ({
  id: row.id,
  direction: row.direction,
  author: row.author,
  kind: row.kind,
  body: row.body,
  // A boolean, not a path: the browser learns that a file exists and is given a route to
  // ask for it. Where it sits on our disk is nobody else's business.
  hasMedia: row.mediaPath !== null,
  mediaMime: row.mediaMime,
  status: row.status,
  sentAt: row.sentAt.toISOString(),
});

export function registerConversationRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
  const agentGuard = requireAgent(db);

  app.get(
    '/api/agents/:agentId/conversations',
    { preHandler: [guard, agentGuard] },
    async (req): Promise<ConversationSummary[]> => {
      const rows = await db
        .select({
          conversation: conversations,
          contact: contacts,
          preview: sql<string | null>`(
            select m.body from messages m
            where m.conversation_id = ${conversations.id}
            order by m.sent_at desc
            limit 1
          )`,
        })
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(eq(conversations.agentId, req.agent!.id))
        .orderBy(sql`${conversations.lastMessageAt} desc nulls last`);

      return rows.map(({ conversation, contact, preview }) => ({
        id: conversation.id,
        contactName: contact.name,
        contactPhone: contact.phone,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        preview,
        windowOpen: windowOpen(conversation.lastInboundAt),
        adHeadline: conversation.adHeadline,
      }));
    },
  );

  app.get(
    '/api/agents/:agentId/conversations/:conversationId',
    { preHandler: [guard, agentGuard] },
    async (req): Promise<ConversationThread> => {
      const { conversationId } = req.params as { conversationId: string };
      const { conversation, contact } = await loadConversation(db, req.agent!.id, conversationId);

      const thread = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(messages.sentAt);

      return {
        id: conversation.id,
        contactName: contact.name,
        contactPhone: contact.phone,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        preview: thread.at(-1)?.body ?? null,
        windowOpen: windowOpen(conversation.lastInboundAt),
        adHeadline: conversation.adHeadline,
        messages: thread.map(toMessage),
      };
    },
  );

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/messages',
    // Any member, not just an owner: answering customers is the job itself.
    { preHandler: [guard, agentGuard] },
    async (req): Promise<Message> => {
      const { conversationId } = req.params as { conversationId: string };

      const parsed = outgoing.safeParse(req.body);
      const body = parsed.success ? parsed.data.body.trim() : '';
      if (!body) throw new ApiError(400, 'Сообщение не может быть пустым');

      const { conversation, contact, number } = await loadConversation(
        db,
        req.agent!.id,
        conversationId,
      );

      if (!number.enabled) {
        throw new ApiError(409, 'Номер отключён. Включите его в интеграциях.');
      }
      if (!windowOpen(conversation.lastInboundAt)) {
        // Refused here rather than by Meta: the explanation stays in the operator's
        // language, and a request nobody can satisfy is not worth sending.
        throw new ApiError(
          409,
          'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.',
        );
      }

      let messageId: string;
      try {
        ({ messageId } = await graph.sendText(
          number.phoneNumberId,
          decryptSecret(number.accessToken, credentialsKey(env)),
          contact.phone,
          body,
        ));
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(502, `Meta не отправила сообщение: ${error.message}`);
        }
        throw error;
      }

      // Stored only after Meta accepted it. A row for a message that never left is a lie
      // the operator would act on.
      const sentAt = new Date();
      const [stored] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          waMessageId: messageId,
          direction: 'out',
          author: 'operator',
          kind: 'text',
          body,
          status: 'sent',
          sentAt,
        })
        .returning();

      await db
        .update(conversations)
        .set({ lastMessageAt: sentAt })
        .where(eq(conversations.id, conversation.id));

      return toMessage(stored!);
    },
  );

  app.get(
    '/api/agents/:agentId/messages/:messageId/media',
    { preHandler: [guard, agentGuard] },
    async (req, reply) => {
      const { messageId } = req.params as { messageId: string };

      const [row] = await db
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.id, messageId), eq(conversations.agentId, req.agent!.id)));

      if (!row?.message.mediaPath) throw new ApiError(404, 'Файл не найден');

      // The only path ever used is the one stored on the row. A path from the request
      // would be a way to read any file the process can reach.
      const file = await readFile(join(env.MEDIA_DIR, row.message.mediaPath)).catch(() => null);
      if (!file) throw new ApiError(404, 'Файл не найден');

      return reply.type(row.message.mediaMime ?? 'application/octet-stream').send(file);
    },
  );
}

/** The conversation with everything the routes need, or a 404 that says nothing more. */
async function loadConversation(db: Db, agentId: string, conversationId: string) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(conversationId)) throw new ApiError(404, 'Диалог не найден');

  const [row] = await db
    .select({ conversation: conversations, contact: contacts, number: whatsappNumbers })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));

  if (!row) throw new ApiError(404, 'Диалог не найден');
  return row;
}
```

The `desc` import is there only if the compiler wants it; the ordering above uses a raw
fragment because `nulls last` has no helper in this version of Drizzle.

- [ ] **Step 5: Register the routes**

In `server/src/api/server.ts`, after the number routes:

```ts
  registerConversationRoutes(app, db, env, guard, graph);
```

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS, sixteen new cases.

- [ ] **Step 7: Commit**

```bash
git add -A server packages/contract
git commit -m "Read conversations, answer them, and serve their files"
```
