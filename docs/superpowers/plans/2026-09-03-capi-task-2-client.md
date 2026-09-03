### Task 2: The Meta client

**Files:**
- Create: `server/src/lib/capi/client.ts`
- Create: `server/test/helpers/fake-capi.ts`
- Modify: `server/src/api/server.ts` (`ServerDeps` gains `capi?`)
- Create: `server/test/capi-client.test.ts`

**Interfaces:**
- Produces:
  - `interface CapiClient { send(input: CapiSend): Promise<CapiResult> }`
  - `interface CapiSend { datasetId: string; token: string; testEventCode: string | null; events: unknown[] }`
  - `interface CapiResult { received: number; fbtraceId: string | null }`
  - `class CapiError extends Error` with `status`, a Russian `message`, a redacted `detail`, and `retryable: boolean`
  - `createCapiClient()`, and `fakeCapi(...)` in the test helper
- `ServerDeps` gains `capi?: CapiClient`, defaulting to `createCapiClient()`, exactly as `graph?`, `pageFetcher?` and `model?` do.

**Context.** The one place that posts to Meta's Conversions API. `server/src/lib/whatsapp/graph.ts` is the pattern and has already solved the deadline, the typed error and the redaction — read it first, especially `within()`, which wraps the whole exchange including the body read.

**The endpoint.** `POST https://graph.facebook.com/v21.0/{datasetId}/events` with `access_token` and a JSON body carrying `data` — the events — and `test_event_code` when one is set. Reuse the Graph API version constant that already exists rather than writing `v21.0` a second time.

**`retryable` is the point of the typed error.** A 400 saying the token is invalid will say the same thing on the fifth attempt; a 429 or a 500 will not. Task 4 stops retrying a permanent refusal immediately and keeps trying a transient one. Decide from the status and from Meta's error `code`/`type` where it gives one, and write down in a comment which are which and why.

- [ ] **Step 1: Write the failing test**

Create `server/test/capi-client.test.ts`, stubbing `fetch` with `vi.stubGlobal` the way `server/test/knowledge-fetch-page.test.ts` and `server/test/openrouter.test.ts` do. Cover:

- a successful send returns `events_received` and the `fbtrace_id`;
- the token goes in the body, not the query string — a query string reaches logs and proxies;
- `test_event_code` is included when set and absent when null;
- a 400 with an invalid-token error is a `CapiError` that is NOT retryable, whose `message` is Russian, and whose `detail` does not contain the token even though Meta echoed it;
- a 429 and a 500 are retryable;
- a body that is not JSON is a `CapiError`, not a `SyntaxError`;
- a timeout is a `CapiError`, not a `DOMException` — including one that expires while the body is being read;
- a network failure is a `CapiError` too, rather than escaping as a `TypeError`.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write the client and the fake**

`fakeCapi` follows `server/test/helpers/fake-model.ts`: it records every call so a test can assert what Meta was told, and answers from a script — a result, or an error to throw — repeating the last entry when the script runs out.

- [ ] **Step 4: Wire it into `ServerDeps`**

- [ ] **Step 5: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Add the Conversions API client"
```
