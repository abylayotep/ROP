# Task 8: Send queue, boot restore, reconnect

**Files:**
- Create: `server/src/lib/whatsapp/linked/queue.ts`, `server/test/linked-lifecycle.test.ts`
- Modify: `server/src/lib/whatsapp/linked/client.ts`, `server/src/index.ts`

**Interfaces:**
- Consumes: `LinkedClient` (Task 4).
- Produces: `restoreLinkedSessions(db, client): Promise<void>`; the queue is internal to the client and changes no signature.

## Steps

- [ ] **Step 1: Write the failing tests**

```ts
it('sends one message at a time, in order', async () => {
  // three concurrent sendText calls → the fake records them in call order,
  // never overlapping
});

it('keeps a minimum gap between two sends to the same number', async () => {
  // with fake timers: second send does not start before MIN_GAP_MS
});

it('does not make one number wait for another', async () => {
  // a slow send on n1 does not delay n2
});

it('connects every open linked number on boot', async () => {
  // two rows 'open', one 'logged_out', one disabled → connect called twice
});

it('does not fail boot when one number refuses to connect', async () => {
  // connect rejects for n1 → n2 still connected, restore resolves
});

it('reconnects after a non-terminal close', async () => {
  // emit closed loggedOut:false → connect called again after the backoff
});

it('marks the number logged out and clears its session on a terminal close', async () => {
  // emit closed loggedOut:true → linked_state 'logged_out', no session rows left,
  // and no reconnect attempt
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm --prefix server test -- linked-lifecycle
```

- [ ] **Step 3: Implement the queue**

One promise chain per number, a module-level `Map<string, Promise<unknown>>`. Each send waits for the previous one to settle, then for `MIN_GAP_MS` plus a jitter of up to a few hundred milliseconds. `MIN_GAP_MS` is a named constant with the reason beside it: bursts are the behaviour WhatsApp bans fastest, and an agent answering three customers at once produces one.

A failed send must not poison the chain — chain on `settled`, not on `then`.

- [ ] **Step 4: Implement reconnect inside the client**

On a `closed` event:

- `loggedOut: true` → set `linked_state = 'logged_out'`, delete the session rows through `linkedAuthState(...).clear()`, drop the session from the registry, emit nothing further. There is no automatic recovery: WhatsApp discarded the pairing, and only a person with the phone can make a new one.
- otherwise → reconnect after a backoff that grows 1s, 2s, 4s, … capped at 60s, resetting on a successful `open`. Give up after a count that is a named constant and leave the row `open` with a logged reason: the phone may simply be off, and forcing a re-pairing for a flat battery would be worse than waiting.

- [ ] **Step 5: Restore on boot**

`restoreLinkedSessions` selects every `whatsapp_numbers` row with `connection_kind = 'linked'`, `linked_state = 'open'` and `enabled = true`, and connects them one at a time. Failures are logged, never thrown: a server that refuses to start because one owner's phone is unreachable takes every other client down with it.

Call it from `server/src/index.ts` after `app.listen()` — the cabinet must answer HTTP before it waits on phones.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test -- linked-lifecycle
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -F - <<'MSG'
Pace the sends, restore the sessions, survive a dropped socket

One queue per number with a minimum gap, because a burst is what gets a number
banned and an agent answering three customers at once produces one. Open
sessions are reconnected on boot, after listen rather than before it, and a
phone that simply went offline is waited for instead of being asked to pair
again — only a logout Meta confirms clears the session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
