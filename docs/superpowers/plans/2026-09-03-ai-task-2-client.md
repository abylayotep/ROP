### Task 2: The OpenRouter client

**Files:**
- Create: `server/src/lib/ai/openrouter.ts`
- Create: `server/test/helpers/fake-model.ts`
- Modify: `server/src/api/server.ts` (`ServerDeps` gains `model?`)
- Create: `server/test/openrouter.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelClient { complete(input: CompletionInput): Promise<Completion> }`
  - `interface CompletionInput { key: string; model: string; temperature: string; messages: ChatMessage[] }`
  - `interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }`
  - `interface Completion { text: string; promptTokens: number; completionTokens: number; cost: string }`
  - `class ModelError extends Error` with a `status` and a Russian `message`
  - `createModelClient()`, and `MODELS` — the models the picker offers
  - `fakeModel(...)` in `server/test/helpers/fake-model.ts`
- `ServerDeps` gains `model?: ModelClient`, defaulting to `createModelClient()`, exactly as `graph?` and `pageFetcher?` do.

**Context.** The one place that talks to a model. Follow `server/src/lib/whatsapp/graph.ts` closely — it is the house pattern for an outbound client, and it already solved the deadline, the typed error and the redaction.

**The key is a secret.** It is stored encrypted, decrypted only to be put in a header, and never appears in an error, a log or a response. `withoutSecret` from `server/src/lib/whatsapp/graph.ts` is exported and already does the redaction; reuse it rather than writing a second one.

**A model list, not a free-text field.** The owner picks from a list this file carries, with a name and a short line about what each is for. A free-text model id would let an owner paste something that does not exist and learn about it from a customer's silence. The list is a constant, and adding to it is one edit.

- [ ] **Step 1: Write the failing test**

Create `server/test/openrouter.test.ts`. No network: stub `fetch` with `vi.stubGlobal`, the way `server/test/knowledge-fetch-page.test.ts` does. Cover:

- a successful completion returns the text, the token counts and the cost from OpenRouter's `usage`;
- a response with no choices raises a `ModelError` with a Russian message;
- a 401 raises a `ModelError` whose message does not contain the key;
- a 429 raises a `ModelError` saying the model is busy, in Russian;
- a body that is not JSON raises a `ModelError` rather than a `SyntaxError`;
- the request carries the key in an `Authorization: Bearer` header and the model and temperature in the body;
- the request carries a deadline, and a timeout becomes a `ModelError` rather than a `DOMException` — assert against a stubbed `fetch` that rejects with a `TimeoutError`;
- `MODELS` is not empty, every entry has an id, a label and a description, and every id contains a `/`.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- openrouter
```

- [ ] **Step 3: Write the client**

Create `server/src/lib/ai/openrouter.ts`. Its shape:

- `const BASE = 'https://openrouter.ai/api/v1'` and `const TIMEOUT_MS = 60_000` — a model is slower than Meta and this runs on the queue rather than on a person's request, so it gets longer than the Graph client's fifteen seconds. Say that in a comment.
- `MODELS`: a readonly array of `{ id, label, description }`. Include at least a fast cheap model, a strong one, and one with a large context. Write the descriptions in Russian — the owner reads them.
- `createModelClient()` posts to `${BASE}/chat/completions` with `Authorization: Bearer <key>`, `model`, `temperature` (a number parsed from the string), `messages`, and `response_format: { type: 'json_object' }`.
- Read `usage.prompt_tokens`, `usage.completion_tokens` and `usage.cost` when present, defaulting to zero and `'0'` — not every model reports all three, and a missing number must not fail a turn that produced a good answer.
- Every failure is a `ModelError` with a Russian message and the status; the raw body goes only through `withoutSecret(…, key)` and only into the `detail`, never into `message`.

`response_format: { type: 'json_object' }` is the one hint most OpenRouter models honour. The prompt in task 3 also says it in words, because some models ignore the field, and task 4 retries once when the answer will not parse. All three together are the reason the JSON approach works across a model list the owner controls.

- [ ] **Step 4: Write the fake**

Create `server/test/helpers/fake-model.ts`, following `server/test/helpers/fake-graph.ts`:

```ts
import type { Completion, CompletionInput, ModelClient } from '../../src/lib/ai/openrouter.js';

export interface FakeModel extends ModelClient {
  /** Every call in order, so a test can assert what the model was actually told. */
  calls: CompletionInput[];
}

/**
 * A model that answers from a script.
 *
 * Pass one string to answer it every time, or several to answer them in order — which is how
 * a test drives the retry: an unparseable answer first, a good one second.
 */
export function fakeModel(...answers: (string | Error)[]): FakeModel { … }
```

Answers run out by repeating the last one. A `Completion`'s token counts and cost are fixed and small, so a test asserting them is asserting the code that reads them rather than a number the fake invented.

- [ ] **Step 5: Wire it into the server**

In `server/src/api/server.ts`, add `model?: ModelClient` to `ServerDeps` with the same comment style the other two have, default it, and hold it for the tasks that follow — nothing registers a route with it yet.

- [ ] **Step 6: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Add the OpenRouter client and the models an owner may pick"
```
