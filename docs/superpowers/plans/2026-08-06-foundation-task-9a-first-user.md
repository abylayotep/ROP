# Task 9a: The first user

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
The deployment stack is [task 9b](2026-08-06-foundation-task-9b-deploy.md).

This task is where the whole plan gets proved: a real login, in a browser, against Postgres.

**Files:**
- Create: `server/src/scripts/create-user.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `loadEnv` (task 2), `createDb` (task 3), `hashPassword` (task 4).
- Produces: `npm --prefix server run create-user`.

- [ ] **Step 1: Add the CLI**

`server/src/scripts/create-user.ts`. There is no sign-up route and there will not be one: this is
a single-company cabinet, and an open registration endpoint would be a liability serving no user.

```ts
import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { hashPassword } from '../lib/password.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const rl = createInterface({ input: process.stdin, output: process.stdout });

// The password is echoed. This runs on a server console, by hand, once — masking it is
// not worth a dependency, but do not run it on a shared screen.
const email = (await rl.question('Email: ')).trim().toLowerCase();
const name = (await rl.question('Name: ')).trim();
const initials = (await rl.question('Initials: ')).trim().toUpperCase();
const password = await rl.question('Password (min 12 chars): ');
rl.close();

if (!email.includes('@') || !name || !initials) {
  console.error('Email, name and initials are all required.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}

await db.insert(users).values({
  email, name, initials, passwordHash: await hashPassword(password),
});

console.log(`Created ${email}.`);
process.exit(0);
```

- [ ] **Step 2: Add the script**

In `server/package.json` scripts:

```json
"create-user": "tsx src/scripts/create-user.ts"
```

- [ ] **Step 3: Verify it refuses a weak password**

```bash
docker compose -f deploy/compose.test.yml up -d
DATABASE_URL=postgres://rakurs:rakurs@localhost:55432/rakurs_test \
  SESSION_SECRET=$(head -c 32 /dev/urandom | base64) \
  npm --prefix server run create-user
```

Enter a password shorter than 12 characters.
Expected: `Password must be at least 12 characters.` and a non-zero exit.

- [ ] **Step 4: Create a real user**

Run the same command again with a password of 12 characters or more.
Expected: `Created <email>.`

- [ ] **Step 5: Prove the whole stack from the browser**

With the server and frontend running as in task 8b, sign in with the user just created.

Expected, and each of these is a distinct thing being proved:

| Observation | What it proves |
|---|---|
| The cabinet opens after sign-in | Cookie set, guard admits it, `/api/auth/me` answers |
| The header shows the initials entered in step 4 | `/api/profile` is reading Postgres, not a fixture |
| A hard refresh keeps you signed in | The session cookie survives, and `getMe` restores state |
| Screens with no data show their empty and error states | Correct for this plan — nothing populates them until plan 2 |

- [ ] **Step 6: Prove logout and expiry**

Delete the `rakurs_session` cookie in devtools and reload.
Expected: the login screen returns rather than a broken cabinet.

- [ ] **Step 7: Commit**

```bash
git add server/src/scripts/create-user.ts server/package.json
git commit -m "Add the first-user CLI

There is no sign-up route by design: one company, and an open
registration endpoint would be a liability serving no user."
```
