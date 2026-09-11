# Task 1: Merge `claude/meta-capi` into `main`

**Files:**
- Resolve: `README.md`, `docs/whatsapp-setup.md`, `rakurs/src/api/index.ts`, `rakurs/src/screens/DialogsScreen.tsx`, `rakurs/src/screens/IntegrationsScreen.tsx`, `server/src/api/server.ts`
- Regenerate: `server/drizzle/meta/_journal.json`, `server/drizzle/meta/0011_snapshot.json`, one new `server/drizzle/00NN_*.sql`
- Delete from the merge: `server/drizzle/0011_needy_hulk.sql` (the coexistence migration, replaced by a regenerated one)

**Interfaces:**
- Consumes: nothing.
- Produces: a `main` that carries `connection_kind` (`'manual' | 'coexistence'`), `business_id`, `sync_requested_at`, `sync_error`, `history_progress` on `whatsapp_numbers`; `messages.author` value `'phone'`; `server/src/api/whatsapp-coexistence.ts`; `server/src/lib/whatsapp/history.ts`; `rakurs/src/lib/embedded-signup.ts`. Every later task builds on these.

## Why this task exists

`claude/meta-capi` is 21 commits of finished, tested coexistence work. `main` has moved 108 commits past their merge base. Both branches added a migration numbered `0011`, and `main` is now at `0016`. Building the linked transport on `main` and merging coexistence afterwards would conflict in exactly the files this task touches — schema, inbound, the integrations screen — with the linked work in the middle.

## Steps

- [ ] **Step 1: Confirm the starting state**

```bash
git -C . status --short          # must be clean
git rev-list --count main..claude/meta-capi   # expect 21
git rev-list --count claude/meta-capi..main   # expect 108
```

- [ ] **Step 2: Create the working branch from `main`**

```bash
git switch -c claude/baileys-linked main
```

- [ ] **Step 3: Start the merge**

```bash
git merge --no-commit --no-ff claude/meta-capi
```

Expected: `Automatic merge failed; fix conflicts`, with eight paths in `git diff --name-only --diff-filter=U`.

- [ ] **Step 4: Resolve the six source and doc conflicts**

Each is a single conflict marker where both sides added a sibling item; keep **both** sides in every one of them:

| File | What each side adds |
|---|---|
| `server/src/api/server.ts` | `main` registers newer route groups; `meta-capi` registers `registerWhatsappCoexistenceRoutes`. Keep every registration, coexistence last. |
| `rakurs/src/api/index.ts` | Both add API functions. Keep both blocks. |
| `rakurs/src/screens/IntegrationsScreen.tsx` | `meta-capi` adds the Embedded Signup card and the number list's kind column; `main` changed the surrounding screen. Keep the new card inside the current layout. |
| `rakurs/src/screens/DialogsScreen.tsx` | `meta-capi` adds the «с телефона» label for `author === 'phone'`. Keep it. |
| `README.md`, `docs/whatsapp-setup.md` | Both sides added sections. Keep both, coexistence after the manual path. |

After each file: `git add <path>`.

- [ ] **Step 5: Take `main`'s migration history and drop the coexistence migration**

```bash
git checkout main -- server/drizzle/
git status --short server/drizzle/
```

The coexistence schema changes still live in `server/src/db/schema.ts`, which merged cleanly. The migration that expressed them is regenerated in the next step, numbered after `0016`.

- [ ] **Step 6: Regenerate the migration from the merged schema**

```bash
npm --prefix server run generate
```

Expected: one new `server/drizzle/0017_*.sql` adding the coexistence columns, plus an updated `_journal.json` and snapshot. Read the generated SQL: it must contain only `ALTER TABLE "whatsapp_numbers" ADD COLUMN` statements for `connection_kind`, `business_id`, `sync_requested_at`, `sync_error`, `history_progress`. Anything else means the schema merge lost or duplicated something — stop and fix the schema, then regenerate.

- [ ] **Step 7: Apply it to the development database**

```bash
DATABASE_URL=postgres://rakurs:rakurs@localhost:55433/rakurs_dev npm --prefix server run migrate
```

- [ ] **Step 8: Run the whole suite**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: green. A failure in `capi-queue`, `session`, `whatsapp-inbound` or `knowledge-import-text` that passes on rerun is the known flake, not this merge. A failure anywhere in `whatsapp-coexistence*`, `whatsapp-history` or `whatsapp-numbers` is this merge and must be fixed here.

- [ ] **Step 9: Commit the merge**

```bash
git add -A
git commit -F - <<'MSG'
Merge the coexistence stage into the current main

Both branches had added an 0011 migration and main had reached 0016, so the
coexistence migration is regenerated from the merged schema rather than
renumbered by hand. Six source and doc conflicts were all "both sides added a
sibling" and keep both sides.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
