# Task 6: Normalize and store what the socket receives

**Files:**
- Create: `server/src/lib/whatsapp/linked/normalize.ts`, `server/src/lib/whatsapp/linked/inbound.ts`, `server/test/linked-inbound.test.ts`
- Modify: `server/src/lib/whatsapp/media.ts`

**Interfaces:**
- Consumes: `LinkedClient` and `RawLinkedMessage` (Task 4); the writers from `store.ts` (Task 5).
- Produces:

```ts
export function normalize(raw: RawLinkedMessage): NormalizedMessage | null;
export function jidToPhone(jid: string): string | null;
export function registerLinkedInbound(db: Db, deps: LinkedInboundDeps, client: LinkedClient): void;
```

`normalize` answers `null` for anything the product does not store: a group message (`jid` ends in `@g.us`), a protocol or reaction message, a status broadcast.

## Steps

- [ ] **Step 1: Write the failing tests**

`server/test/linked-inbound.test.ts`, driving `fakeLinked()`:

```ts
it('stores an incoming text as a client line and runs a turn', async () => { … });

it('stores a message the owner sent from the phone as an outgoing operator line', async () => {
  // raw.key.fromMe = true
  // expect direction 'out', author 'phone', and NO turn
});

it('never answers a line the owner already answered', async () => {
  // two events: a client line, then a fromMe line with a later timestamp
  // expect exactly one turn, for the client line
});

it('ignores group messages', async () => {
  // raw.key.remoteJid = '1234-5678@g.us' → nothing written
});

it('ignores status broadcasts', async () => {
  // remoteJid 'status@broadcast' → nothing written
});

it('stores an image with its caption and downloads the file once', async () => { … });

it('keeps the message when the media download fails', async () => {
  // downloadMedia rejects → row exists, media_path null
});

it('stores a redelivered message once', async () => {
  // same key.id twice → one row, one turn
});

it('reads the sender from the jid', () => {
  expect(jidToPhone('77085807932@s.whatsapp.net')).toBe('77085807932');
  expect(jidToPhone('77085807932:12@s.whatsapp.net')).toBe('77085807932');
  expect(jidToPhone('1234-5678@g.us')).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm --prefix server test -- linked-inbound
```

- [ ] **Step 3: Implement `normalize.ts`**

The mapping from a Baileys message to `NormalizedMessage`:

| Baileys field | Result |
|---|---|
| `message.conversation` or `message.extendedTextMessage.text` | `kind: 'text'`, that string as `body` |
| `message.imageMessage` | `kind: 'image'`, `caption` as `body` |
| `message.videoMessage` | `kind: 'video'`, `caption` as `body` |
| `message.audioMessage` | `kind: 'audio'`, `body: null` |
| `message.documentMessage` | `kind: 'document'`, `caption` as `body` |
| `message.stickerMessage` | `kind: 'sticker'`, `body: null` |
| anything else | `kind: 'unsupported'`, `body: null` |
| `key.remoteJid` ending `@g.us`, or `status@broadcast`, or a `protocolMessage` / `reactionMessage` | `null` — not stored at all |

`messageTimestamp` is seconds and may arrive as a `Long`; convert through `Number(...)` before multiplying. `key.id` is the message id and is what the unique index deduplicates on.

- [ ] **Step 4: Implement `inbound.ts`**

`registerLinkedInbound` subscribes one handler to the client and, for a `message` event:

1. `normalize`; `null` returns immediately;
2. load the number by `id` — the event carries `numberId`, so no lookup by jid is needed;
3. `upsertContact` / `upsertConversation`;
4. skip the media download if the message id is already stored, exactly as the Cloud API path does — a redelivery must not refetch bytes already on disk;
5. `storeMessage`; only a line this pass actually stored is eligible for a turn;
6. `advanceConversation`;
7. `runTurns` — **never** when `fromMe`.

Wrap the body in a try/catch per message and log failures: one malformed message must not take down the socket and with it every other conversation on that number.

- [ ] **Step 5: Teach `media.ts` a second source**

`downloadInboundMedia` fetches through the Graph client today. Give it a sibling `storeInboundMedia(deps, { bytes, mime, agentId, waMessageId })` that writes bytes already in hand, and have the Graph path call it after its download. The linked path calls `client.downloadMedia` and then `storeInboundMedia`. Naming, directory layout and extension choice stay exactly as they are — the cabinet serves both through the same route.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test -- linked-inbound
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -F - <<'MSG'
Write down what the phone's socket receives

Baileys messages are normalized into the same line the Cloud API pipeline
produces and written by the same code. A message the owner sent from their
handset is stored as an outgoing line by author 'phone' and never answered:
mirroring it is what keeps the agent from replying to a customer a human has
already replied to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
