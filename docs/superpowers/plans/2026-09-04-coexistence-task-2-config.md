# Task 2: Configuration and Graph v26.0

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md).

**Files:**
- Modify: `server/src/env.ts`, `server/.env.example`, `deploy/env.example`, `deploy/compose.yml`, `README.md`
- Modify: `server/src/lib/whatsapp/graph.ts:10` (`GRAPH_VERSION`)
- Modify: `server/test/helpers/env.ts`, `server/test/env.test.ts`, `server/test/graph.test.ts`, `server/test/capi-client.test.ts`

**Interfaces:**
- Produces: `Env.META_APP_ID: string`, `Env.META_ES_CONFIG_ID: string`; `GRAPH_ROOT === 'https://graph.facebook.com/v26.0'`.

- [ ] **Step 1: Failing env test**

Add to `server/test/env.test.ts` inside `describe('loadEnv')`:

```ts
  it('requires the Meta application id and the Embedded Signup configuration id', () => {
    expect(() => loadEnv({ ...valid, META_APP_ID: undefined } as NodeJS.ProcessEnv)).toThrow(/META_APP_ID/);
    expect(() => loadEnv({ ...valid, META_ES_CONFIG_ID: '' } as NodeJS.ProcessEnv)).toThrow(/META_ES_CONFIG_ID/);
  });
```

and add to the `valid` object in that file:

```ts
  META_APP_ID: '1585667806534384',
  META_ES_CONFIG_ID: '1234567890',
```

Also add both lines to `server/test/helpers/env.ts` inside `testEnv`'s defaults (after `META_WEBHOOK_VERIFY_TOKEN`), and to the `refuses a credentials key` case's inline object (`META_APP_ID: '1', META_ES_CONFIG_ID: '1'`), since that test constructs its own environment.

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- env` → the new test fails: `loadEnv` does not know the variables, so nothing throws.

- [ ] **Step 3: Extend the schema**

In `server/src/env.ts`, after `META_WEBHOOK_VERIFY_TOKEN`:

```ts
  /**
   * The Meta application's id. Public by nature — it is in every Embedded Signup URL — but
   * it must match `META_APP_SECRET`, which is why both come from the same place.
   */
  META_APP_ID: z.string().min(1),
  /** The Facebook Login for Business configuration Embedded Signup runs with. */
  META_ES_CONFIG_ID: z.string().min(1),
```

- [ ] **Step 4: Examples and Compose**

`server/.env.example`, after `META_WEBHOOK_VERIFY_TOKEN=`:

```
# ID приложения Meta и ID конфигурации Facebook Login for Business. Нужны, чтобы
# подключить номер, который уже живёт в WhatsApp Business на телефоне (Embedded Signup).
# Meta → приложение → Основные → App ID; Вход через Facebook для компаний → Конфигурации.
META_APP_ID=
META_ES_CONFIG_ID=
```

`deploy/env.example`, after `META_WEBHOOK_VERIFY_TOKEN=`:

```
# ID приложения Meta и ID конфигурации Login for Business — для подключения номера с телефона.
META_APP_ID=
META_ES_CONFIG_ID=
```

`deploy/compose.yml`, in `api.environment` after `META_WEBHOOK_VERIFY_TOKEN`:

```yaml
      META_APP_ID: ${META_APP_ID:?set META_APP_ID}
      META_ES_CONFIG_ID: ${META_ES_CONFIG_ID:?set META_ES_CONFIG_ID}
```

`README.md`: change «пять дополнительных переменных» to «семь» and add two bullets after `META_WEBHOOK_VERIFY_TOKEN`:

```markdown
- `META_APP_ID` — ID приложения Meta; браузер запускает с ним Embedded Signup;
- `META_ES_CONFIG_ID` — ID конфигурации Facebook Login for Business для Embedded Signup;
```

- [ ] **Step 5: Graph version**

`server/src/lib/whatsapp/graph.ts:10`: `const GRAPH_VERSION = 'v26.0';`

Update the three URL assertions: `server/test/graph.test.ts` (two `v21.0` occurrences at lines ~47, ~59, ~69) and `server/test/capi-client.test.ts:89` → `v26.0`.

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add server/src/env.ts server/.env.example deploy/env.example deploy/compose.yml README.md server/src/lib/whatsapp/graph.ts server/test
git commit -m "Require the Meta app id and Embedded Signup config, and move to Graph v26.0"
```
