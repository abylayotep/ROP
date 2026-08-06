# Infrastructure, failure behaviour, testing

Part of [Rakurs — Production Readiness](2026-08-06-rakurs-production-design.md).

## Layout

```
ROP/
├── rakurs/            frontend, stays where it is
├── server/
│   └── src/
│       ├── api/       Fastify routes, one file per resource
│       ├── db/        Drizzle schema and migrations
│       ├── meta/      Marketing API and Conversions API clients
│       ├── whatsapp/  Baileys process
│       ├── model/     LLM adapter, prompts, output schemas
│       ├── jobs/      worker loop and handlers
│       └── lib/       phone normalisation, hashing, tracking codes
├── docs/
└── deploy/            compose file, nginx, deploy script
```

`server/` imports domain types from `../rakurs/src/types` through a tsconfig path. The import is
type-only, so nothing couples at build time, but the contract becomes physically impossible to
drift: `tsc` on the server fails the moment the frontend's types and the server's responses
disagree. Two npm projects, no workspace — the frontend does not move, and nothing about its
build changes.

## Processes

Docker Compose runs four services; nginx stays on the host, where certbot already manages TLS
and where `deploy/nginx.conf.example` expects it.

| Service | Role |
|---|---|
| `postgres` | Database. Not published to the host — reachable only on the compose network. |
| `api` | Fastify. Sessions, all `/api` routes. The only service nginx talks to. |
| `worker` | Job loop: Meta sync, conversation analysis, payment parsing, CAPI delivery. |
| `whatsapp` | Baileys. Holds the session, ingests messages, publishes QR. |

Baileys is a separate process deliberately. It is the component most likely to crash — an
unhandled protocol change takes it down — and a crash there must not take the dashboard with
it. It communicates only through Postgres: QR payloads and link state go into `wa_sessions`,
messages into `messages`. No Redis, no message bus, nothing else to keep alive at 3am.

Baileys is pinned to an exact version. It tracks an undocumented protocol and minor releases
break without warning; upgrades are a deliberate act with the number re-linked afterwards.

## Environment

```
DATABASE_URL           postgres://…
SESSION_SECRET         cookie signing
WA_CREDS_KEY           AES-GCM key for wa_sessions.creds
META_ACCESS_TOKEN      system user, ads_read + ads_management
META_BUSINESS_ID
META_PIXEL_ID
META_CAPI_TOKEN
META_API_VERSION       pinned, e.g. v21.0
ANTHROPIC_API_KEY
DEFAULT_COUNTRY        KZ — phone normalisation for numbers written without a country code
```

None of these are `VITE_`-prefixed and none may become so. Anything with that prefix is compiled
into the bundle and readable by anyone who opens the page source. The frontend's only
configuration is `VITE_API_URL=/api`.

## Deployment

```bash
npm --prefix rakurs run build
rsync -a --delete rakurs/dist/ vps:/var/www/rakurs/
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml run --rm api npm run migrate
```

nginx: `root /var/www/rakurs`, `/api` → `127.0.0.1:3000`, and `try_files $uri $uri/ /index.html`
— without that last line the router lives only in the browser and a refresh on `/dialogs`
returns 404. Analysis and Meta sync take tens of seconds, so `proxy_read_timeout` stays raised.

Backups: nightly `pg_dump`. `wa_sessions.creds` is excluded from any dump that leaves the VPS —
it is a live login to a real person's WhatsApp account.

## Failure behaviour

Meta and WhatsApp fail routinely. This is ordinary operation, and the product is designed for it
rather than around it. Screens read from our database, never from a live upstream call.

| Failure | What the user sees |
|---|---|
| Meta sync fails | Spend and insights from `ad_daily`, header shows when data was last updated, integrations screen shows the error |
| Baileys disconnects | Reconnect with backoff. Stored conversations, analyses and payments are unaffected — they live in Postgres |
| Session logged out or number banned | Settings shows "номер отключён, привяжите заново". All history stays |
| Model unavailable | The conversation is listed without analysis and marked as such. The job retries |
| CAPI delivery fails | The payment stands. The event parks as `failed` after bounded retries and appears on the reconciliation panel |
| Postgres down | 503; the frontend's existing retry state handles it |

One rule throughout: never render a zero where the truth is "not known". The frontend already
distinguishes these — "За этот период оплат ещё нет" versus a dash — and the API must preserve
the distinction with nulls rather than flattening them to `0`.

## Testing

**Unit, no database.** Phone normalisation to E.164 including the default-country path;
tracking-code generation and collision handling; code extraction from message text, including
edited and multi-message cases; payment-row matching across exact, fuzzy and unmatched;
Conversions API payload construction and SHA-256 phone hashing; staleness computation.

**Integration, against a real Postgres in a container.** Migrations apply from empty. Job
claiming stays correct under concurrent workers (`FOR UPDATE SKIP LOCKED`). Message ingestion is
idempotent when Baileys replays history — the case that inflates every count if it regresses.
Payment re-import of an overlapping list creates no duplicate rows and no second CAPI event.

**Meta is never called live from tests.** Recorded responses only, including a throttle response
and a restated-spend response, since both happen in production and neither is convenient to
reproduce on demand.

**The model adapter is stubbed**, with one test that a recorded real response parses cleanly
against the output schema.

**Contract drift is caught by the compiler.** Because `server/` imports the frontend's types,
`npm run typecheck` in `server/` is the contract test. `mock-server/` migrates alongside and
keeps the frontend developable without any backend at all.

## Security

Sessions are httpOnly, `Secure`, `SameSite=Lax`; passwords are argon2id; login is rate-limited
per IP and per account. Postgres is not published outside the compose network. `wa_sessions.creds`
is encrypted at rest with `WA_CREDS_KEY` and excluded from logs and dumps.

The bridge itself remains the standing risk: it violates Meta's terms, and the number can be
banned at any time. Everything the product knows survives that event, because none of it is
stored in WhatsApp.
