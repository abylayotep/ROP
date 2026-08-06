# Rakurs — Production Readiness

**Date:** 2026-08-06
**Status:** Approved. Ready for implementation planning.

## Goal

Rakurs shows which ads bring *money* rather than leads, and where that money leaks in seller
conversations. Paid orders flow back to Meta through the Conversions API with the invoice
amount, so the algorithm optimises for buyers instead of form fills.

The frontend implements all of this and works. There is no backend: every screen talks to
`mock-server/`, which serves invented data. This spec covers building the backend that
replaces those fixtures with real data, plus the frontend changes production forces.

## Starting point

| | |
|---|---|
| Frontend | Complete — React 18 + TypeScript + Vite, 7 screens, ~6000 lines. |
| Backend | Does not exist. Not one line. |
| Fixtures | `mock-server/` — 1665 lines over the exact API contract. |
| Version control | None before this spec. `git init` is step one. |

**Client environment.** Available: Meta Business Manager with live ad accounts, a VPS with a
domain, an LLM API key. Not available: any CRM, and no WhatsApp Business Account (WABA).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| WhatsApp transport | Self-hosted Baileys on the VPS | The UI is built around QR device linking, and reading sellers' actual conversations is the product. The official Cloud API offers neither. Cost: this violates Meta's terms and numbers do get banned — accepted knowingly. |
| Scale at launch | One number | One Baileys process. No worker pool, no session orchestration. |
| Payment source | Owner pastes free text; a model parses it | No CRM exists. The text contains client phone numbers, so every payment joins cleanly to a conversation, an ad, and a Meta event. |
| Contract shape | Server returns numbers and enums | The current contract makes the server emit CSS colours (`statusFg`, `qDot`, `blockFg`) and pre-formatted strings (`Seller.conv`, `sales`, `reply`). Formatting moves to the frontend, which already has `lib/format.ts` and `lib/tone.ts` for it. Model-written prose stays server-side. |
| Scope of this pass | Whole loop at once | Skeleton, Meta, WhatsApp, analysis, payments and CAPI together, rather than shipping Meta first. Slower to first result, but the product is only meaningful once the loop closes. |
| Runtime | Node + TypeScript, Fastify, PostgreSQL + Drizzle | Baileys is Node-only, so the language is settled. Postgres for Russian full-text search over messages and JSONB analysis output. |

## The loop

```
Meta ad  ──tracking code in prefilled text──▶  first inbound WhatsApp message
   │                                                      │
   │                                          conversation bound to the ad
   │                                                      │
   │                                              model analyses it
   │                                                      │
   │                                    owner pastes payment text
   │                                                      │
   │                              phone → contact → conversation → ad
   │                                                      │
   └────────── Conversions API, hashed phone + amount ◀────┘
```

Each hop is specified in [attribution and money](2026-08-06-rakurs-attribution-and-money.md).

## Risks

**Attribution is the fragile link.** Baileys reads the raw WhatsApp protocol and does not
receive Meta's ad referral the way the Cloud API webhook does. Binding a conversation to an
ad therefore depends on a tracking code the client must paste into each ad's prefilled text
in Ads Manager. This is a client action, not a code change; without it the Creatives screen
shows spend but not what the spend earned.

**Numbers get banned.** The bridge violates Meta's terms. A banned number loses live message
ingestion; stored conversations, analyses and payments survive because they live in our
database, not in WhatsApp. Broadcasts multiply this risk and are deliberately out of scope
here — see Deferred below.

**Meta and WhatsApp both fail routinely.** Treated as normal operation, not incidents. All
screens read from our database, never from a live upstream call, and show how stale the data
is. Degradation rules are in [infrastructure](2026-08-06-rakurs-infrastructure.md).

## Deferred

Out of scope for this pass, each needing its own spec:

- **Broadcasts** (`BroadcastScreen`, 707 lines). Highest ban risk of anything in the product.
  Bulk sending through a bridge is what gets numbers killed fastest. Needs its own risk design.
- **AI agent** (`AgentScreen`, 857 lines). An autonomous responder writing to real clients is a
  separate product with its own failure modes.
- **Instagram Direct.** Second transport, second attribution path.
- **Multi-tenancy.** `Profile.planLine` hints at a SaaS shape. Built single-tenant.
- **Mobile layout.** Content area has `min-width: 1150px` by design.

Both deferred screens stay reachable and render honest empty states rather than fixtures.

## What the client must provide

| Item | Needed for |
|---|---|
| Meta system-user token (`ads_read`, `ads_management`) | Ad accounts, ads, spend, on/off toggles |
| Meta Business ID | Enumerating owned ad accounts |
| Pixel ID + Conversions API token | Sending purchases back |
| VPS SSH access and domain | Deployment, TLS |
| Anthropic API key | Conversation analysis, payment-text parsing |
| WhatsApp number to link | The bridge |
| Tracking codes pasted into ad prefilled texts | Attribution — the one item no code can substitute |

## Documents

| Read this | For |
|---|---|
| [Data model](2026-08-06-rakurs-data-model.md) | Tables, keys, retention |
| [Attribution and money](2026-08-06-rakurs-attribution-and-money.md) | Ad binding, analysis, payment import, CAPI |
| [API contract](2026-08-06-rakurs-api-contract.md) | Endpoint-by-endpoint changes, new screens, frontend edits |
| [Infrastructure](2026-08-06-rakurs-infrastructure.md) | Processes, deployment, failure behaviour, testing |
