# Task 1: Workspace and shared contract package

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

The frontend's `src/types/index.ts` is the API contract. Moving it into a package both sides
import turns contract drift into a compile error instead of a production bug.

**Files:**
- Create: `package.json`, `packages/contract/package.json`, `packages/contract/index.ts`
- Modify: `rakurs/src/types/index.ts` — becomes a re-export

**Interfaces:**
- Produces: `@rakurs/contract` — every type previously in `rakurs/src/types/index.ts`, unchanged.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "rakurs-monorepo",
  "private": true,
  "workspaces": ["packages/*", "rakurs", "server"]
}
```

- [ ] **Step 2: Create the contract package**

`packages/contract/package.json`. No build step: consumers are TypeScript and read the source
directly, so there is no compiled output to keep in sync.

```json
{
  "name": "@rakurs/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "types": "./index.ts",
  "exports": { ".": "./index.ts" }
}
```

- [ ] **Step 3: Move the types**

```bash
git mv rakurs/src/types/index.ts packages/contract/index.ts
```

- [ ] **Step 4: Re-export from the old location**

Write `rakurs/src/types/index.ts`. Roughly thirty files import from `@/types`; re-exporting
leaves every one of them untouched.

`export type *` rather than `export *`: the file contains only types, and the `type` keyword
erases the statement at build time instead of emitting a runtime import of a package that has
no runtime code.

```ts
/** The API contract lives in @rakurs/contract so the server imports the same file. */
export type * from '@rakurs/contract';
```

- [ ] **Step 5: Install and verify the frontend is unchanged**

```bash
npm install
```

- [ ] **Step 6: Run the frontend's own checks**

```bash
npm --prefix rakurs run typecheck && npm --prefix rakurs run build
```

Expected: both pass. No frontend source was touched apart from the re-export, so a failure here
is workspace resolution, not a frontend regression. If Vite cannot resolve `@rakurs/contract`,
confirm `npm install` was run from the repository root and that the symlink
`node_modules/@rakurs/contract` exists.

- [ ] **Step 7: Verify the types really are shared**

Temporarily add a deliberate error to prove the wiring is live rather than silently falling back
to a stale copy:

```bash
printf '\nexport type ProofOfWiring = { x: number };\n' >> packages/contract/index.ts
```

Then in `rakurs/src/App.tsx` add near the top:

```ts
import type { ProofOfWiring } from '@/types';
const proof: ProofOfWiring = { x: 'not a number' };
```

Run `npm --prefix rakurs run typecheck`.
Expected: FAIL with a type error on `proof`. That failure is the proof. Now revert both edits:

```bash
git checkout rakurs/src/App.tsx
git checkout packages/contract/index.ts 2>/dev/null || \
  sed -i '' '/ProofOfWiring/d' packages/contract/index.ts
```

- [ ] **Step 8: Confirm the revert is clean**

```bash
npm --prefix rakurs run typecheck
git diff --stat
```

Expected: typecheck passes, and the diff shows only the intended moves — no `ProofOfWiring`
anywhere.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Extract API contract into a shared workspace package

The frontend's src/types/index.ts is the wire contract. Moving it into a
package the server will also import makes drift a compile error rather
than a production bug. The old path re-exports, so no import site changes."
```
