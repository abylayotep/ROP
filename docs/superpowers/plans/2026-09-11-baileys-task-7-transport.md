# Task 7: The transport interface and the window rule

**Files:**
- Create: `server/src/lib/whatsapp/transport.ts`, `server/test/transport.test.ts`
- Modify: `server/src/api/conversations.ts`, `server/src/lib/ai/turn.ts`

**Interfaces:**
- Consumes: `LinkedClient` (Task 4), `GraphClient`.
- Produces:

```ts
export interface MessageTransport {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  sendMedia(to: string, file: OutgoingFile): Promise<{ messageId: string }>;
  /** Cloud API only. A linked device has no 24-hour window and no templates. */
  readonly requiresOpenWindow: boolean;
}

/** `WhatsappNumberRow` is `typeof whatsappNumbers.$inferSelect`. */
export function transportFor(
  number: WhatsappNumberRow,
  deps: { graph: GraphClient; linked: LinkedClient; key: Buffer },
): MessageTransport;
```

## Why the window moves

`windowOpen(conversation.lastInboundAt)` is checked unconditionally before every send. It encodes a Cloud API rule: outside 24 hours since the customer's last message, Meta refuses anything but a template. A linked device has no such rule. Left as it is, the cabinet would refuse sends that WhatsApp would have delivered — a bug that looks like a policy.

## Steps

- [ ] **Step 1: Write the failing tests**

`server/test/transport.test.ts`:

```ts
it('sends a manual number through the graph client with its decrypted token', async () => { … });

it('sends a coexistence number through the graph client', async () => { … });

it('sends a linked number through the socket, addressed by jid', async () => {
  // expect linked.sendText called with (numberId, '<phone>@s.whatsapp.net', body)
});

it('requires an open window for the Cloud API kinds and not for linked', () => {
  expect(transportFor(manual, deps).requiresOpenWindow).toBe(true);
  expect(transportFor(coexistence, deps).requiresOpenWindow).toBe(true);
  expect(transportFor(linked, deps).requiresOpenWindow).toBe(false);
});

it('refuses a token it cannot decrypt with a sentence an operator can act on', async () => { … });
```

Then, in `server/test/conversations.test.ts`, two tests at the route level:

```ts
it('refuses an operator reply outside the window on a manual number', async () => { … });

it('allows an operator reply outside the window on a linked number', async () => { … });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm --prefix server test -- transport conversations
```

- [ ] **Step 3: Implement `transport.ts`**

The cloud wrapper decrypts the token once, at construction, and turns `GraphError` into the same 502 text `conversations.ts` produces today. The linked wrapper builds the jid as `` `${phone}@s.whatsapp.net` `` and turns `LinkedOffline` into a 409 with:

- `linked_state = 'logged_out'` → «Телефон отвязал кабинет. Нужно подключить заново по QR.»
- otherwise → «Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.»

Both sentences are Russian because the frontend renders `message` verbatim.

- [ ] **Step 4: Convert the two send sites**

In `server/src/api/conversations.ts`, replace the token decryption and the `graph.sendText` call with:

```ts
      const transport = transportFor(number, { graph, linked, key: credentialsKey(env) });
      if (transport.requiresOpenWindow && !windowOpen(conversation.lastInboundAt)) {
        throw new ApiError(409, 'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.');
      }
```

and the send itself with `transport.sendText(contact.phone, body)`.

In `server/src/lib/ai/turn.ts`, the same substitution at the one call site. `TurnDeps` gains `linked: LinkedClient`; every construction site of `TurnDeps` — `index.ts`, the inbound pipelines, and the tests — passes it.

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test -- transport conversations turn
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -F - <<'MSG'
Choose how a message leaves by the number it leaves through

Two call sites knew how to talk to Meta; now they ask the number for a
transport and say what to send. The 24-hour window goes with it: it is a Cloud
API rule, and enforcing it on a linked device refused sends WhatsApp would
have delivered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
