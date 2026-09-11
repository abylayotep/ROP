# Task 4: `LinkedClient` — interface, fake, socket

**Files:**
- Create: `server/src/lib/whatsapp/linked/client.ts`, `server/src/lib/whatsapp/linked/socket.ts`, `server/test/helpers/fake-linked.ts`, `server/test/linked-client.test.ts`

**Interfaces:**
- Consumes: `linkedAuthState` (Task 3).
- Produces:

```ts
export interface OutgoingFile { path: string; mime: string; filename?: string; caption?: string }

export type LinkedEvent =
  | { type: 'qr'; numberId: string; qr: string }
  | { type: 'open'; numberId: string; jid: string; displayPhone: string }
  | { type: 'closed'; numberId: string; loggedOut: boolean }
  | { type: 'message'; numberId: string; message: RawLinkedMessage }
  | { type: 'history'; numberId: string; chunk: RawLinkedHistory };

export interface LinkedClient {
  connect(numberId: string): Promise<void>;
  disconnect(numberId: string): Promise<void>;
  logout(numberId: string): Promise<void>;
  sendText(numberId: string, toJid: string, body: string): Promise<{ messageId: string }>;
  sendMedia(numberId: string, toJid: string, file: OutgoingFile): Promise<{ messageId: string }>;
  downloadMedia(numberId: string, message: RawLinkedMessage): Promise<Buffer>;
  isOpen(numberId: string): boolean;
  on(handler: (event: LinkedEvent) => void): void;
}
```

`RawLinkedMessage` is Baileys' `proto.IWebMessageInfo` re-exported under our own name, so that nothing outside `socket.ts` imports the library's types either.

## Steps

- [ ] **Step 1: Write the interface and the fake first**

`server/test/helpers/fake-linked.ts` follows `fake-graph.ts` exactly: it records calls, answers plausibly, accepts per-method overrides, and adds one thing a fake socket needs and a fake HTTP client does not — a way to push events:

```ts
export interface FakeLinked extends LinkedClient {
  calls: { method: keyof LinkedClient; args: unknown[] }[];
  /** Drives a handler registered through `on`, the way a real socket would. */
  emit(event: LinkedEvent): void;
  /** Flips what `isOpen` answers. */
  setOpen(numberId: string, open: boolean): void;
}
```

- [ ] **Step 2: Write the failing test**

`server/test/linked-client.test.ts` covers only what the registry — not Baileys — is responsible for:

```ts
it('refuses to send through a number that is not open', async () => {
  const client = fakeLinked();
  client.setOpen('n1', false);
  await expect(client.sendText('n1', '7700@s.whatsapp.net', 'hi')).rejects.toThrow(LinkedOffline);
});

it('delivers every event to every registered handler', () => {
  const client = fakeLinked();
  const seen: LinkedEvent[] = [];
  client.on((event) => seen.push(event));
  client.on((event) => seen.push(event));
  client.emit({ type: 'qr', numberId: 'n1', qr: '2@abc' });
  expect(seen).toHaveLength(2);
});

it('connect is idempotent for a number already connected', async () => {
  const client = fakeLinked();
  await client.connect('n1');
  await client.connect('n1');
  expect(client.calls.filter((c) => c.method === 'connect')).toHaveLength(2);
  expect(client.isOpen('n1')).toBe(true);
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm --prefix server test -- linked-client
```

- [ ] **Step 4: Implement `client.ts` — the registry**

`client.ts` owns a `Map<numberId, Session>` and the handler list, and knows nothing about WhatsApp. It exposes `createLinkedClient(deps)` where `deps` supplies the socket factory, so tests can hand it a fake factory and production hands it the real one from `socket.ts`.

`LinkedOffline` is an `Error` subclass exported from here; the send routes turn it into a 409 with a Russian sentence.

- [ ] **Step 5: Implement `socket.ts` — the only Baileys import**

```ts
import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
```

What it does, and nothing else:

- builds the socket with the auth state from Task 3 and a `browser` triple that names this product;
- subscribes to `connection.update` → emits `qr`, `open` (reading `sock.user.id` for the jid) and `closed` (`loggedOut` is `(lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.loggedOut`);
- subscribes to `creds.update` → `saveCreds()`;
- subscribes to `messages.upsert` → one `message` event per entry, `type: 'notify'` only (`append` is a sync artefact and would replay old lines as new);
- subscribes to `messaging-history.set` → one `history` event per chunk;
- implements `sendText` / `sendMedia` / `downloadMedia` over `sock.sendMessage` and `downloadMediaMessage`.

Pass a silent logger. Baileys logs every frame at debug by default, which in production is a stream of message content into the server log.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test -- linked-client
```

Expected: PASS.

- [ ] **Step 7: Full suite and commit**

```bash
npm --prefix server test && npm --prefix server run typecheck
git add -A && git commit -F - <<'MSG'
Put the linked-device socket behind an interface

One file imports Baileys and one registry owns the live sessions; everything
else in the product talks to LinkedClient, which a test can fake the way it
already fakes the Graph client. Only `notify` upserts become message events —
`append` is a sync artefact, and replaying it would answer old lines as if
they had just arrived.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
