# Task 5: Extract the shared writers

**Files:**
- Create: `server/src/lib/whatsapp/store.ts`
- Modify: `server/src/lib/whatsapp/inbound.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
export interface StoredLine { conversationId: string; agentId: string; stored: boolean }

export async function upsertContact(db: Db, agentId: string, phone: string, name?: string): Promise<string>;
export async function upsertConversation(db: Db, agentId: string, numberId: string, contactId: string): Promise<string>;
export async function storeMessage(db: Db, conversationId: string, line: NormalizedMessage, media: StoredMedia | null): Promise<boolean>;
export async function advanceConversation(db: Db, conversationId: string, sentAt: Date, inbound: boolean): Promise<void>;
export async function runTurns(db: Db, deps: TurnDeps, touched: Touched): Promise<string[]>;
```

`StoredMedia` is `{ path: string; mime: string }`, the shape `media.ts` already returns.
`NormalizedMessage` is the transport-independent shape both pipelines produce:

```ts
export interface NormalizedMessage {
  waMessageId: string;
  from: string;          // digits, the shape contacts.phone uses
  fromMe: boolean;
  sentAt: Date;
  kind: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'unsupported';
  body: string | null;
}
```

## Why this is its own task

`inbound.ts` is 500 lines and does two jobs: it parses Meta's payload shape, and it writes the rows that parse produces. Only the second half is transport-independent. Copying it into the linked pipeline would give the product two places where a conversation's `lastInboundAt` is advanced, and they would drift.

This task is a **pure refactor**: no behaviour changes, no test changes except imports. That is what makes it safe to run beside Task 4.

## Steps

- [ ] **Step 1: Run the existing tests and record the baseline**

```bash
npm --prefix server test -- whatsapp
```

Write down the number of passing tests. That number must be identical at the end of this task.

- [ ] **Step 2: Move the four writers and the turn runner verbatim**

Cut `upsertContact`, `upsertConversation`, `storeMessage` and `runTurns` out of `inbound.ts` into `store.ts`, unchanged except for their new `export`. Move the `Touched` type with them. Move the `at()` helper only if `store.ts` needs it; the timestamp shape is Meta's, so it more likely stays behind.

- [ ] **Step 3: Give `storeMessage` the normalized shape**

`storeMessage` currently takes Meta's `InboundMessage` and reads `bodyOf`/`mediaIdOf` out of it. Change its parameter to `NormalizedMessage` and move `bodyOf`/`mediaIdOf` to the caller in `inbound.ts`, which is where Meta's shape belongs. It also gains `direction` and `author` from `fromMe`:

```ts
      direction: line.fromMe ? 'out' : 'in',
      author: line.fromMe ? 'phone' : 'client',
```

`'phone'` is the author value the coexistence stage already added for exactly this case — a message the owner sent from their handset.

- [ ] **Step 4: Extract `advanceConversation`**

The `greatest(...)` update at the bottom of `applyChange` moves into `store.ts` as `advanceConversation`, with `inbound` deciding whether `lastInboundAt` moves too. The comment explaining why both columns only ever move forward moves with it — it is the reason the function exists.

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test -- whatsapp
npm --prefix server test
npm --prefix server run typecheck
```

Expected: exactly the baseline from Step 1. A changed count means this was not a pure refactor — find what moved and put it back.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -F - <<'MSG'
Separate writing a message down from parsing Meta's payload

Only half of inbound.ts is about Meta: the other half writes contacts,
conversations, messages and runs the agent's turn, and a second transport
needs exactly that half. Moved verbatim, with storeMessage now taking a
transport-independent line instead of Meta's own shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
