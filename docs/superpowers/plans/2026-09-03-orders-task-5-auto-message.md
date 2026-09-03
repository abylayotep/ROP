### Task 5: The auto-message on entering a stage

**Files:**
- Create: `server/src/lib/funnel-message.ts`
- Modify: `server/src/api/leads.ts` (the stage change in the PATCH route, and the signature of `registerLeadRoutes`)
- Modify: `server/src/api/server.ts` (pass the env and the graph client to `registerLeadRoutes`)
- Modify: `packages/contract/index.ts` (one comment)
- Create: `server/test/funnel-message.test.ts`

**Interfaces:**
- Consumes: `GraphClient`, `GraphError` and `withoutSecret` from `server/src/lib/whatsapp/graph.ts`; `windowOpen` from `server/src/api/conversations.ts`; `decryptSecret` and `credentialsKey` from `server/src/lib/secret-box.ts`.
- Produces: `renderTemplate(template, contactName)` and `sendStageMessage(db, deps, { conversationId, stageId })` from `server/src/lib/funnel-message.ts`, with `interface StageMessageDeps { graph: GraphClient; key: Buffer }`.
- `registerLeadRoutes(app, db, env, guard, graph)` — the signature grows by two, matching `registerConversationRoutes`.

**Context.** Task 4 records a stage change. This makes the change do something: the stage's template goes out to the customer. It is the operator's own follow-up without the AI, which arrives in stage 5.

**The rules, all of them load-bearing.**

- A template fires only when the stage actually changed, which task 4's PATCH route already knows.
- It never fires on the first stage a lead is ever given. A lead that has just written already got an answer; a template on top of it reads as a machine.
- A closed 24-hour window does not send. Neither does a disabled number.
- Nothing here throws. A stage move must not fail because Meta refused a message: the move is what the operator asked for, and the message is the extra. Every refusal becomes a note on the lead instead.

- [ ] **Step 1: Write the failing test**

Create `server/test/funnel-message.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  contacts,
  conversations,
  messages,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { renderTemplate } from '../src/lib/funnel-message.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let accountId: string;
let agentId: string;
let numberId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** Rebuilds the server on a different Graph client and signs back in. */
async function withGraph(next: FakeGraph) {
  await app.close();
  graph = next;
  app = buildServer(env, db, { graph });
  await app.ready();
  jar = await login();
}

async function stageNamed(name: string) {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.name === name)!;
}

/** Gives a stage a template and returns its id. */
async function template(name: string, text: string) {
  const stage = await stageNamed(name);
  await app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/stages/${stage.id}`,
    cookies: jar,
    payload: { autoMessage: text },
  });
  return stage.id;
}

const move = (stageId: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
    cookies: jar,
    payload: { stageId },
  });

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));

  graph = fakeGraph();
  app = buildServer(env, db, { graph });
  await app.ready();
  jar = await login();

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
      accessToken: encryptSecret('EAAG-token', key, '136'),
    })
    .returning();
  numberId = number!.id;

  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: numberId,
      // Inside the window: the customer wrote a minute ago.
      lastInboundAt: new Date(Date.now() - 60_000),
      lastMessageAt: new Date(Date.now() - 60_000),
    })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('renderTemplate', () => {
  it('puts the name in', () => {
    expect(renderTemplate('Здравствуйте, {{name}}!', 'Айгуль')).toBe('Здравствуйте, Айгуль!');
  });

  it('leaves nothing behind when there is no name', () => {
    // Not a placeholder: the customer would read whatever we put here.
    expect(renderTemplate('Здравствуйте, {{name}}!', null)).toBe('Здравствуйте, !');
  });

  it('replaces every occurrence', () => {
    expect(renderTemplate('{{name}}, {{name}}', 'Аян')).toBe('Аян, Аян');
  });

  it('leaves an unknown placeholder alone', () => {
    expect(renderTemplate('Ваш {{product}}', 'Аян')).toBe('Ваш {{product}}');
  });
});

describe('the stage auto-message', () => {
  it('is not sent when the lead is given its first stage', async () => {
    const stageId = await template('В диалоге', 'Здравствуйте, {{name}}!');

    await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(0);
  });

  it('is sent on a later move and stored as a message', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте, {{name}}! Мы на связи.');
    await move(first.id);

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    const sent = graph.calls.filter((call) => call.method === 'sendText');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[3]).toBe('Здравствуйте, Айгуль! Мы на связи.');

    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.direction).toBe('out');
    expect(stored[0]?.author).toBe('system');
    expect(stored[0]?.status).toBe('sent');
  });

  it('sends nothing for a stage with no template', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await move(first.id);

    await move(second.id);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
  });

  it('writes a note instead of sending when the window is closed', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await db
      .update(conversations)
      .set({ lastInboundAt: new Date(Date.now() - DAY - 60_000) })
      .where(eq(conversations.id, conversationId));

    const res = await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect(res.json().stageId).toBe(stageId);
    expect(res.json().notes).toHaveLength(1);
    expect(res.json().notes[0].body).toContain('окно');
    expect(res.json().notes[0].authorName).toBeNull();
  });

  it('writes a note instead of sending when the number is off', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await db.update(whatsappNumbers).set({ enabled: false }).where(eq(whatsappNumbers.id, numberId));

    const res = await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect(res.json().notes[0].body).toContain('номер');
  });

  it('keeps the move when Meta refuses the message', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Malformed access token EAAG-token', 401, 190);
        },
      }),
    );

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stageId);
    expect(res.json().notes).toHaveLength(1);
    // The token Meta echoed back must not be written into the note.
    expect(res.json().notes[0].body).not.toContain('EAAG-token');
    expect(res.json().notes[0].body).toContain('<токен скрыт>');
  });

  it('moves the conversation forward in the list when it sends', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    const before = await db.select().from(conversations).where(eq(conversations.id, conversationId));

    await move(stageId);

    const after = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(after[0]!.lastMessageAt!.getTime()).toBeGreaterThan(
      before[0]!.lastMessageAt!.getTime(),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- funnel-message
```

Expected: the file does not compile — `../src/lib/funnel-message.js` does not exist.

- [ ] **Step 3: Write the sender**

Create `server/src/lib/funnel-message.ts`:

```ts
import { eq } from 'drizzle-orm';
import { windowOpen } from '../api/conversations.js';
import type { Db } from '../db/client.js';
import { contacts, conversations, messages, notes, stages, whatsappNumbers } from '../db/schema.js';
import { decryptSecret } from './secret-box.js';
import { GraphError, withoutSecret, type GraphClient } from './whatsapp/graph.js';

export interface StageMessageDeps {
  graph: GraphClient;
  key: Buffer;
}

/**
 * Fills a stage's template.
 *
 * A lead with no profile name gets nothing where the name would be, not a placeholder:
 * the customer reads this text, and "Здравствуйте, клиент!" is worse than the comma.
 * An unknown placeholder is left as written — silently deleting it would hide the typo
 * from whoever wrote the template.
 */
export function renderTemplate(template: string, contactName: string | null): string {
  return template.split('{{name}}').join(contactName ?? '');
}

/**
 * Sends the template of the stage a lead has just entered, or records why it could not.
 *
 * Never throws. The stage move is what the operator asked for and it has already
 * happened; the message is the extra, and an extra that fails must not undo the ask.
 * Every refusal lands as a note on the lead, where the person who moved it will see it.
 */
export async function sendStageMessage(
  db: Db,
  deps: StageMessageDeps,
  input: { conversationId: string; stageId: string },
): Promise<void> {
  const note = (body: string) =>
    db.insert(notes).values({ conversationId: input.conversationId, authorId: null, body });

  try {
    const [stage] = await db.select().from(stages).where(eq(stages.id, input.stageId));
    const text = stage?.autoMessage?.trim();
    if (!text) return;

    const [row] = await db
      .select({ conversation: conversations, contact: contacts, number: whatsappNumbers })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
      .where(eq(conversations.id, input.conversationId));
    if (!row) return;

    if (!row.number.enabled) {
      await note(`Автосообщение стадии «${stage!.name}» не отправлено: номер отключён.`);
      return;
    }
    if (!windowOpen(row.conversation.lastInboundAt)) {
      await note(
        `Автосообщение стадии «${stage!.name}» не отправлено: окно ответа закрыто, ` +
          'клиент не писал больше суток.',
      );
      return;
    }

    const body = renderTemplate(text, row.contact.name);
    let token = '';
    try {
      // Decrypted inside the try on purpose, the same way the inbound path does it: a key
      // that no longer matches must cost this one message, not raise past this function.
      token = decryptSecret(row.number.accessToken, deps.key, row.number.phoneNumberId);
      const { messageId } = await deps.graph.sendText(
        row.number.phoneNumberId,
        token,
        row.contact.phone,
        body,
      );

      const sentAt = new Date();
      await db.insert(messages).values({
        conversationId: input.conversationId,
        waMessageId: messageId,
        direction: 'out',
        // Not 'operator': nobody typed this. Stage 5's replies are 'ai', and the thread
        // has to be able to say which of the three sent a line.
        author: 'system',
        kind: 'text',
        body,
        status: 'sent',
        sentAt,
      });
      await db
        .update(conversations)
        .set({ lastMessageAt: sentAt })
        .where(eq(conversations.id, input.conversationId));
    } catch (error) {
      const reason =
        error instanceof GraphError || error instanceof Error ? error.message : String(error);
      // Meta echoes a rejected token back inside its own error text. Redacted before it
      // reaches a column anyone can read.
      await note(
        `Автосообщение стадии «${stage!.name}» не отправлено: ${withoutSecret(reason, token)}`,
      );
    }
  } catch {
    // Even the note failed. There is nothing left to tell anyone with, and raising here
    // would turn a successful stage move into a 500.
  }
}
```

- [ ] **Step 4: Fire it from the stage change**

In `server/src/api/leads.ts`:

Change the signature and take the two new arguments:

```ts
export function registerLeadRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
```

with the imports:

```ts
import type { Env } from '../env.js';
import { credentialsKey } from '../lib/secret-box.js';
import { sendStageMessage } from '../lib/funnel-message.js';
import type { GraphClient } from '../lib/whatsapp/graph.js';
```

In the PATCH handler, after the `db.update(conversations).set(patch)` call, add:

```ts
      if (Object.keys(patch).length > 0) {
        await db.update(conversations).set(patch).where(eq(conversations.id, conversationId));
      }

      // Only on a real move to a real stage, and never on the first one a lead is given:
      // a customer who has just written already has an answer, and a template on top of
      // it is the cabinet talking over its own operator.
      if (patch.stageId != null && current.stageId !== null) {
        await sendStageMessage(
          db,
          { graph, key: credentialsKey(env) },
          { conversationId, stageId: patch.stageId },
        );
      }
```

- [ ] **Step 5: Pass the dependencies in**

In `server/src/api/server.ts`, change the call to:

```ts
  registerLeadRoutes(app, db, env, guard, graph);
```

- [ ] **Step 6: Widen one contract comment**

In `packages/contract/index.ts`, the `Message.author` comment becomes:

```ts
  /** 'client' | 'operator' | 'ai' | 'system' — 'system' is the cabinet's own auto-message. */
  author: string;
```

- [ ] **Step 7: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/funnel-message.ts server/src/api/leads.ts server/src/api/server.ts packages/contract/index.ts server/test/funnel-message.test.ts
git commit -m "Send a stage template when a lead enters the stage"
```
