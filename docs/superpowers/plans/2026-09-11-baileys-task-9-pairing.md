# Task 9: Pairing routes and the QR stream

**Files:**
- Create: `server/src/api/whatsapp-linked.ts`, `server/test/linked-pairing.test.ts`
- Modify: `server/src/api/server.ts`, `packages/contract/index.ts`

**Interfaces:**
- Consumes: `LinkedClient` (Task 4), the lifecycle from Task 8.
- Produces:

| Route | Body / answer |
|---|---|
| `POST /api/agents/:agentId/whatsapp/linked` | `{}` → `WhatsappNumber` with `linkedState: 'pairing'`. Owner only. |
| `GET /api/agents/:agentId/whatsapp/linked/:numberId/qr` | `text/event-stream`: `{"type":"qr","qr":"…"}`, then `{"type":"open"}` or `{"type":"failed","reason":"…"}`. Owner only. |
| `DELETE /api/agents/:agentId/whatsapp/linked/:numberId` | `{ ok: true }`. Logs the device out, drops the session, keeps conversations. Owner only. |

Contract gains `LinkedPairingEvent = { type: 'qr'; qr: string } | { type: 'open' } | { type: 'failed'; reason: string }`.

## Steps

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a pairing row and starts a session', async () => { … });

it('refuses a second pairing while one is already in progress for the agent', async () => {
  // 409, «Подключение уже идёт. Закройте его или дождитесь окончания.»
});

it('streams every QR the socket emits', async () => {
  // subscribe, emit two qr events, expect two SSE frames
});

it('finishes the stream on open and fills the number in', async () => {
  // emit open → SSE 'open' frame, row has linked_jid, display_phone, state 'open'
});

it('gives up after the pairing deadline and removes the row', async () => {
  // fake timers past PAIRING_TIMEOUT_MS → 'failed' frame, no row left
});

it('refuses pairing to a member who is not the owner', async () => { … });

it('unlinks: logs out, clears the session, keeps the conversations', async () => { … });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm --prefix server test -- linked-pairing
```

- [ ] **Step 3: Implement the routes**

The pairing row is created first, in state `pairing`, with `display_phone` set to an empty string and `linked_jid` to a placeholder the check constraint accepts — **no**: the constraint requires a real `linked_jid`, and there is none until the phone answers. Create the row with `linked_jid` set to `pending:<row uuid>` and overwrite it on `open`. Say so in a comment; a reader will otherwise wonder why a jid column holds something that is not a jid.

The stream is a Fastify route that sets the SSE headers and keeps the reply open, subscribing to the client's events filtered by `numberId`. On `open`, `failed` or the client disconnecting, unsubscribe and end the reply — a handler left registered after a browser tab closes is a leak that outlives the pairing.

`PAIRING_TIMEOUT_MS` is five minutes, the same deadline the Embedded Signup flow uses for its popup, and for the same reason: a flow nobody finished must not leave a half-created row in the list.

- [ ] **Step 4: Register the routes**

`server/src/api/server.ts`, beside `registerWhatsappCoexistenceRoutes`.

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test -- linked-pairing
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -F - <<'MSG'
Pair a phone by streaming its QR codes to the cabinet

A QR lives seconds and is reissued until someone scans it, so pairing is an
event stream rather than one image: the browser subscribes, the socket pushes,
and the row fills itself in when the phone answers. Five minutes without a
scan removes the row — a flow nobody finished must not leave a half-created
number in the list.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
