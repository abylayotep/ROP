# Task 1: Configuration and the secret box

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Five new environment variables and the one helper that keeps an access token unreadable in the
database. Every later task depends on both, so they land first.

Adding required variables breaks every test that builds an environment inline, so this task
also gives the suite one place to build a test environment.

**Files:**
- Modify: `server/src/env.ts`
- Create: `server/src/lib/secret-box.ts`
- Create: `server/test/helpers/env.ts`
- Modify: `server/test/auth.test.ts`, `server/test/agents-routes.test.ts`, `server/test/require-agent.test.ts`, `server/test/env.test.ts`
- Modify: `server/.env.example`, `deploy/env.example`
- Test: `server/test/secret-box.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encryptSecret(plain: string, key: Buffer): string` and
  `decryptSecret(packed: string, key: Buffer): string` from `server/src/lib/secret-box.ts`;
  `credentialsKey(env: Env): Buffer` from the same file; `testEnv(overrides?): Env` from
  `server/test/helpers/env.ts`; and on `Env` the fields `META_APP_SECRET`,
  `META_WEBHOOK_VERIFY_TOKEN`, `CREDENTIALS_KEY`, `MEDIA_DIR`, `PUBLIC_URL`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/secret-box.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';

const key = randomBytes(32);

describe('secret box', () => {
  it('returns the original text', () => {
    const packed = encryptSecret('EAAG...a-real-looking-token', key);

    expect(decryptSecret(packed, key)).toBe('EAAG...a-real-looking-token');
  });

  it('never stores the plain text', () => {
    expect(encryptSecret('super-secret', key)).not.toContain('super-secret');
  });

  it('gives a different result every time, so equal tokens do not look equal', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses text that was tampered with', () => {
    const [iv, tag, body] = encryptSecret('original', key).split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;

    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
  });

  it('refuses another key', () => {
    expect(() => decryptSecret(encryptSecret('original', key), randomBytes(32))).toThrow();
  });

  it('refuses a value that is not in the stored shape', () => {
    expect(() => decryptSecret('not-encrypted-at-all', key)).toThrow(
      'Stored secret is malformed',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- secret-box
```

Expected: FAIL — cannot resolve `../src/lib/secret-box.js`.

- [ ] **Step 3: Write the secret box**

Create `server/src/lib/secret-box.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../env.js';

/**
 * Symmetric encryption for the credentials we store on a client's behalf.
 *
 * A WhatsApp access token can send messages as the client's business, so a database dump
 * or one careless `psql` session would otherwise hand that ability to whoever read it.
 *
 * AES-256-GCM rather than CBC: it authenticates as well as encrypts, so a value edited in
 * the database fails to decrypt instead of decrypting into something else.
 */

const ALGORITHM = 'aes-256-gcm';

/** 96 bits is the size GCM is specified for; longer nonces are hashed and gain nothing. */
const IV_BYTES = 12;

/** A fresh nonce per call, so encrypting the same token twice does not produce equal rows. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptSecret(packed: string, key: Buffer): string {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new Error('Stored secret is malformed');

  const [iv, tag, body] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  // Throws on a wrong key or edited ciphertext — GCM verifies the tag in final().
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The key as bytes. Validated at boot, so this cannot be the wrong length here. */
export const credentialsKey = (env: Env): Buffer => Buffer.from(env.CREDENTIALS_KEY, 'base64');
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm --prefix server test -- secret-box
```

Expected: PASS, six cases.

- [ ] **Step 5: Add the variables**

In `server/src/env.ts`, extend the schema object with:

```ts
  /** Signs every webhook delivery. One per Meta application, not per client. */
  META_APP_SECRET: z.string().min(1),
  /** The string Meta echoes back during the webhook handshake. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  /**
   * 32 bytes, base64. Losing it makes every stored access token unreadable and they have
   * to be pasted again; leaking it makes them readable to whoever has the database.
   */
  CREDENTIALS_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  /** Where downloaded WhatsApp media is written. */
  MEDIA_DIR: z.string().min(1).default('var/media'),
  /** How this server is reachable from the internet; shown as the webhook address. */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
```

- [ ] **Step 6: Give the suite one place to build an environment**

Create `server/test/helpers/env.ts`:

```ts
import { loadEnv, type Env } from '../../src/env.js';

/**
 * A valid environment for tests.
 *
 * It exists so that adding a required variable is one edit rather than one per test file,
 * and so every suite agrees on the secret the webhook signature tests sign with.
 */
export function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    SESSION_SECRET: 'x'.repeat(32),
    META_APP_SECRET: 'test-app-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64'),
    MEDIA_DIR: 'var/media-test',
    PUBLIC_URL: 'https://rakurs.test',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
```

- [ ] **Step 7: Point the existing suites at it**

`server/test/auth.test.ts`, `server/test/agents-routes.test.ts` and
`server/test/require-agent.test.ts` each build an environment inline with `loadEnv({...})`.
Replace that block in each with:

```ts
import { testEnv } from './helpers/env.js';

const env = testEnv();
```

and drop the now-unused `loadEnv` import. `server/test/env.test.ts` tests `loadEnv` itself and
keeps calling it directly — extend its valid-input cases with the five new variables so it
still passes, and add one case:

```ts
  it('refuses a credentials key that is not 32 bytes', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://x',
        SESSION_SECRET: 'x'.repeat(32),
        META_APP_SECRET: 's',
        META_WEBHOOK_VERIFY_TOKEN: 'v',
        CREDENTIALS_KEY: Buffer.alloc(16).toString('base64'),
      } as NodeJS.ProcessEnv),
    ).toThrow('must be 32 bytes, base64-encoded');
  });
```

- [ ] **Step 8: Document the variables**

Append to `server/.env.example`, keeping its Russian prose:

```
# Секрет приложения Meta. Им подписан каждый вебхук — без него мы не отличим
# доставку от Meta от чужого запроса. Meta → приложение → Основные → App Secret.
META_APP_SECRET=

# Строка, которую Meta присылает при проверке вебхука и ждёт обратно.
# Придумайте любую и вставьте её же в настройках вебхука в Meta.
META_WEBHOOK_VERIFY_TOKEN=

# Ключ шифрования токенов в базе. Ровно 32 байта в base64:
#   head -c 32 /dev/urandom | base64
# Потеряете — токены придётся вводить заново.
CREDENTIALS_KEY=

# Куда складывать файлы из WhatsApp. Локально можно оставить как есть.
MEDIA_DIR=var/media

# Как сервер виден снаружи. Локально — адрес туннеля, на VPS — домен.
# Из него собирается адрес вебхука, который вы вставляете в Meta.
PUBLIC_URL=http://localhost:3000
```

Add the same five to `deploy/env.example` with one-line Russian comments, since Compose passes
the environment there.

- [ ] **Step 9: Add the media directory to gitignore**

Append to `.gitignore`:

```
# Файлы из WhatsApp: приходят от клиентов, в репозитории им не место.
var/media/
```

- [ ] **Step 10: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS. Every suite now builds its environment through `testEnv()`.

- [ ] **Step 11: Commit**

```bash
git add -A server deploy .gitignore
git commit -m "Add WhatsApp configuration and encrypt stored credentials"
```
