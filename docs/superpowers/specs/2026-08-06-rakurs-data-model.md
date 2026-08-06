# Data model

PostgreSQL, migrations through Drizzle. Types below are abbreviated DDL, not the final
migration. Part of [Rakurs — Production Readiness](2026-08-06-rakurs-production-design.md).

**Secrets never land here.** Meta tokens, the Anthropic key and the session cookie secret come
from the environment. The one exception is `wa_sessions.creds`, which cannot live in env
because Baileys rewrites it on every reconnect — see Secrets at the bottom.

## Access

```sql
users    (id uuid pk, email citext unique, password_hash text,   -- argon2id
          name text, initials text, role text, created_at timestamptz)
sessions (id uuid pk,                                            -- the cookie value itself
          user_id uuid → users on delete cascade,
          expires_at timestamptz, created_at timestamptz)
```

The frontend already sends `credentials: 'include'`; sessions are httpOnly, `SameSite=Lax`,
`Secure` cookies. No OAuth — one company, a handful of users.

## Advertising

```sql
ad_accounts (id text pk,                        -- 'act_123456'
             name text, currency text,          -- ISO 4217, from Meta
             status text, synced_at timestamptz)

ads (id text pk,                                -- Meta ad id
     ad_account_id text → ad_accounts, campaign_id text, campaign_name text,
     adset_id text, adset_name text, name text, objective text, format text,
     status text,                               -- 'active'|'learning'|'review'|'off'
     tracking_code text unique,                 -- ours, pasted into the ad's prefilled text
     created_at timestamptz, synced_at timestamptz)

ad_daily (ad_id text → ads on delete cascade, date date,
          spend numeric(14,2), impressions bigint, clicks bigint,
          meta_results bigint,                  -- Meta "results" = conversations, not payments
          meta_purchases bigint, frequency numeric(6,2),
          primary key (ad_id, date))
```

Daily granularity, not per-period rows: every on-screen period (7/30/90 days) is a `SUM` over a
date range, and re-syncing one day is an idempotent upsert. Meta's Insights API is rate-limited
hard enough that calling it per page view is not an option — screens read `ad_daily`.

## Settings

```sql
settings (id boolean pk default true check (id),   -- single row, enforced by the check
          project_name text, currency text,        -- report currency, e.g. 'KZT'
          usd_rate numeric(12,4), timezone text,   -- e.g. 'Asia/Almaty'
          selected_account_ids text[], sync_mode text,
          meta_business_id text, meta_pixel_id text, updated_at timestamptz)
```

## WhatsApp

```sql
sellers (id uuid pk, name text, initials text, active boolean)

wa_sessions (id uuid pk, seller_id uuid → sellers, phone text,   -- E.164, null until linked
             state text,          -- 'pending'|'waiting'|'linked'|'expired'|'logged_out'
             qr_payload text,     -- current QR string, null unless waiting
             creds jsonb,         -- Baileys auth state. A live WhatsApp login.
             linked_at timestamptz, last_seen_at timestamptz, created_at timestamptz)

contacts (id uuid pk, phone_e164 text unique, name text,   -- WhatsApp push name
          city text,                                       -- model-extracted, nullable
          first_seen_at timestamptz)

conversations (id uuid pk, contact_id uuid → contacts,
               wa_session_id uuid → wa_sessions, seller_id uuid → sellers,
               ad_id text → ads,
               attribution_source text,      -- 'code'|'referral'|'manual'|null
               started_at timestamptz, last_message_at timestamptz)

messages (id uuid pk, conversation_id uuid → conversations on delete cascade,
          wa_message_id text unique,        -- dedup key, see below
          direction text,                   -- 'in'|'out'
          sent_at timestamptz, text text,
          attachments jsonb default '[]', raw jsonb)
```

Indexes: `conversations (last_message_at desc)`, `conversations (ad_id)`,
`messages (conversation_id, sent_at)`.

`wa_message_id unique` carries the whole deduplication story. Baileys replays history on every
reconnect, and reconnects are frequent — without that constraint the same message is ingested
repeatedly and every downstream count inflates.

`attribution_source` is nullable on purpose. A conversation with no tracking code and no ad
referral is genuinely unattributed, and the UI says so rather than guessing.

## Analysis

```sql
analyses (conversation_id uuid pk → conversations on delete cascade,
          messages_hash text,        -- sha256 over message ids + timestamps
          model text, analyzed_at timestamptz,
          outcome text,              -- 'bought'|'lost'|'in_progress'
          client_gender text,        -- 'male'|'female'|'unknown'
          ask text, for_whom text, purpose text,
          sent text[],               -- what the seller sent: photos, price list, calculation
          score smallint,            -- 0..100
          ready_to_buy boolean, loss_reason text,
          outcome_title text, outcome_text text,   -- model prose, rendered as written
          draft text, draft_meta text)             -- suggested reply
```

One row per conversation, recomputed only when `messages_hash` changes. Running the model on
every page view would be expensive and would produce a different verdict each time for the same
conversation.

`client_gender` exists because the current contract ships `DialogStatus` as `'Купил' | 'Купила'`
— outcome and grammatical gender fused into one string. Splitting them lets the frontend handle
the declension, which is where that belongs.

## Money

```sql
payment_imports (id uuid pk, raw_text text,
                 parsed jsonb,     -- model output, before the operator confirms it
                 status text,      -- 'parsing'|'review'|'confirmed'|'discarded'
                 created_by uuid → users, created_at timestamptz)

payments (id uuid pk, import_id uuid → payment_imports,
          phone_e164 text, client_name text,
          amount numeric(14,2), currency text, paid_at date,
          contact_id uuid → contacts, conversation_id uuid → conversations,
          ad_id text → ads,
          match_confidence text,        -- 'exact'|'fuzzy'|'none'
          confirmed_at timestamptz, confirmed_by uuid → users)

create unique index on payments (phone_e164, paid_at, amount);
```

That unique index is the re-import guard. The owner will paste overlapping lists — pasting the
same week twice must not double revenue or fire a second Meta event for one purchase.

```sql
capi_events (id uuid pk, payment_id uuid → payments on delete cascade,
             event_id text unique,   -- sent to Meta as event_id, its deduplication key
             event_name text,        -- 'Purchase'
             status text,            -- 'pending'|'sent'|'confirmed'|'failed'
             attempts smallint, sent_at timestamptz,
             meta_response jsonb, last_error text)
```

Two independent deduplication layers — ours on `payments`, Meta's on `event_id` — because a
duplicate Purchase corrupts algorithm training, and that damage is not reversible by deleting
rows later.

## Jobs

```sql
jobs (id bigserial pk, kind text, payload jsonb,
      run_at timestamptz, attempts smallint,
      locked_at timestamptz, locked_by text,
      status text default 'queued', last_error text)

create index on jobs (status, run_at);
```

Kinds: `sync_meta`, `analyze_conversation`, `send_capi`, `parse_payments`. Claimed with
`SELECT … FOR UPDATE SKIP LOCKED`. No Redis or external broker: there is one worker process,
and Postgres already provides durability, retry bookkeeping and — usefully during incidents —
a queue you can inspect with SQL.

## Retention and secrets

`messages.raw` holds the full Baileys payload and is the largest table by far. Keep 180 days,
then drop `raw` while retaining the parsed row; analyses and payments are unaffected.

`wa_sessions.creds` is a live WhatsApp login for a real person's number. It is the only secret
in the database, it is written by Baileys on every reconnect so env storage is impossible, and
it must be encrypted at rest with a key from the environment, excluded from logs, and excluded
from any database dump that leaves the VPS.
