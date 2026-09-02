# pleep.app research — how the reference product works

**Date:** 2026-09-02
**Purpose:** Reference for the Rakurs pivot. Observed in the owner's pleep.app trial account
(agent "Сафина", WhatsApp `waba_coexistence`) and in the public docs at docs.pleep.app.
Only the features we plan to build are covered in depth: WhatsApp, orders funnel, agent,
knowledge base, Meta CAPI, statistics.

## 1. Product shape

- Account → many **AI sales reps** (agents). Each agent has its own knowledge base, script,
  channels, funnel, stats. Team roles: Owner, Administrator, Member. Plans gate channel count.
- Agent navigation: Chats, Knowledge Base, Testing (sandbox), Improvement, Broadcasts,
  Scenarios, Settings · Statistics, Customers · Integrations, Extensions, Tools, Voice Agent.
- Onboarding: paste a website or Instagram URL → content scraped → knowledge base and sales
  script generated → connect channels.
- Agent config is **versioned** (sandbox shows "Текущая версия · v18").

## 2. WhatsApp

### Connection modes

| Mode | What it is | Trade-offs (from docs) |
|---|---|---|
| `waba_coexistence` | Same number stays in the WhatsApp Business app **and** works through Cloud API | 20 msg/s; first message from Click-to-WhatsApp ads can be lost; app auto-greeting disables the agent; ad attribution "incomplete or missing"; some outbound failures not reported |
| `waba` ("WhatsApp + calls") | Dedicated Cloud API number, app no longer works | 80 msg/s (up to 1000); complete ad message delivery and attribution; calls |

Pleep connects via **Embedded Signup** (Facebook popup): log in → pick Business Portfolio →
pick/create WABA → pick number → SMS/voice verification. Migration coexistence → Cloud API is
done manually by their support.

Prerequisites Pleep lists for the client: number in WhatsApp Business app for ≥7 days, Meta
Business Portfolio (name cannot be changed later, must match documents), a Facebook Page of
type business/brand linked to the portfolio, complete business profile, a Visa/Mastercard in
Meta Business Settings for template messages.

### Stored per connected number

`phone_number_id` (shown as the account id) and "Bot ID" = `phone_number_id:waba_id`.
Multiple numbers per account, one marked Primary. Per-number toggle "Integration enabled".

### Settings

- Mark messages as read (read receipts). Forced on while typing effect is on.
- Typing effect ("typing…" while generating).
- WhatsApp Business auto-greeting: enter the app's greeting text so the AI recognises it
  instead of handing the chat off (coexistence only).

### 24-hour window

After the window closes the composer says "Window closed. Only a template will reach them"
and offers approved templates. Follow-up extension can substitute an approved variable-free
template when the window is closed.

### Limits and quality (docs)

Unverified business: 250 unique contacts/day business-initiated; verified tiers 1k → 10k →
100k → unlimited. Quality rating green/yellow/red. Warm-up schedule for new numbers.
Template messages cost ~30–40 KZT per recipient in Kazakhstan; inside the window replies are free.

### Templates and broadcasts

Template editor: name, language, category (Service/Utility vs Marketing, plus Authentication),
optional call-permission button, header (text/image/video/document), body with `{{1}}`
variables and example values, footer, buttons. Approval usually minutes, up to 24h.
Public API `POST /api/v1/messages/send-template` with `bot_id`, `channel`
(`waba` | `waba_coexistence`), recipients + params.

## 3. Chats and the orders funnel

### Views

Kanban (columns = funnel stages) and List. Filters: channel, read/unread, lead status
(all/active/converted/not converted), funnel stage. Date range picker. Search. "Card display"
chooses phone vs name, tags, and which lead attributes show on cards. "Set up routing" assigns
chats to teammates by a plain-language description of who handles what.

### Stage model ("Edit status" dialog)

| Field | Values / meaning |
|---|---|
| name, color | free |
| stage type (`kind`) | `active`, `qualified`, `awaiting_payment`, `success`, `failure` |
| "When to use this status" | free text; the AI reads it to decide when to move a lead here |
| AI replies in this status | toggle; off keeps the agent silent in that stage |
| Protected status | AI cannot move a lead out; manual moves still allowed |
| Auto-message on entering | template text with `{{lead.name}}`, `{{lead.status.name}}`, `{{assistant.name}}` or AI-written |

Exactly one stage should be the sale. The UI warns "2 stages are marked as the sale, so stats
and ad events split between them" and offers to rebuild the whole funnel from the agent prompt.
The **AI itself moves leads between stages** ("AI updated lead status"); `status_set_by` is
`AI | OPERATOR_MANUAL | SCENARIO | SYSTEM`, webhooks add `VERIFIED_OUTCOME`.

### Lead card (right panel of a chat)

- Header: name, phone, channel, last activity, "AI is turned on" + **Disable AI** button.
- **Meta Conversions API → Send to Meta** (dropdown). Disabled with tooltip "This lead didn't
  come from a Facebook or Instagram ad, so Meta has no click to attribute the purchase to".
- Assigned to (teammate or routing).
- Status select (all stages).
- **Details** = lead fields filled by the AI ("AI saved customer information"): custom fields
  defined in Settings → Lead Fields (name, type text/number/date, AI hint) plus system fields:
  Drop-off reason, Conversion driver, Objections, Topics discussed, Intent stage, Qualification.
  "+" adds a field inline.
- Notes.
- Under each AI message: thumbs-down (correction), copy, **Sources** (the knowledge-base chunks
  retrieved for that answer, with an edit shortcut).
- Timeline shows tool events: "AI searched knowledge base for … · 5 results found",
  "AI saved customer information", "AI updated lead status".

### Customers

One row per phone: channel, stage, value, activity, owner, tag, plus hidden columns
(first contact, source, handled by, chats, messages, phone). Filters: outcome
(in progress / bought / lost) and channels. Row opens a drawer with details and "Open chat".

## 4. Agent

### Sales script (Improvement → Sales Script)

Ordered phases (Знакомство, Квалификация, Презентация, Закрытие). Each step: title,
instruction text, **bound funnel stage**, "Next step", "Branch" with an `IF:` condition
(e.g. IF: модель выбрана / оплата получена / не подходит). List and Diagram views.
Menu: upload document, translate, sync. Editing a step edits the agent's instructions.

### Improvement chat

Owner describes a problem in plain words or pastes a screenshot. The system validates
specificity, then proposes typed changes with confidence: **Edit instructions** (diff to the
rules/dialogue flow) or **Add knowledge** (new KB item, e.g. a 14-model catalogue with photos).
Owner confirms → "Fix applied"; optional "Save as a required behavior check". Tabs: Drafts
(pending), History (every applied change with "Create reversal draft" / Revert). "Which agent
to edit": text vs voice. Chat feedback (thumbs-down + correction) feeds the same loop.

### Settings

Name, description, timezone, reply languages (first is fallback), branding, **forced handoff
message** instructions (used when the hallucination guard rejects a reply twice or a critical
defect is found; the message itself is generated per customer language), lead fields, clear cache.

### Extensions relevant to us

Follow-up Touches (after N minutes, up to 3 reminders, separate intervals, quiet hours,
AI instructions, template fallback when the WhatsApp window is closed), Dialog Auto-switching
(AI pauses when an operator replies, resumes later), Working Hours, Message Delay, Message
Splitting, Handoff to Operator (toggle; stats: could-not-answer / escalated / KB questions),
Telegram Notifications.

### Scenarios

Triggers: client doesn't reply in a stage for N hours/days; lead moves to a stage; lead's saved
date arrives; recurring scheduled send. Actions in order: send a message (template or AI, at most
one message per scenario, "send when" condition), notify an operator, more via "Add action".
Options: respect working hours, do-not-disturb window, apply to existing leads.

### Tools

Custom HTTP tools: camelCase name, description ("when and how the agent should use it"),
method + URL with `{param}` path params, headers, query parameters the AI collects from the
conversation, "send files returned by this tool" (attachments field → sent as files), timeout.
Separate MCP Servers tab. Kaspi tools exist as built-ins (`create_kaspi_invoice`,
`get_kaspi_invoice_status`, `cancel_kaspi_invoice`, `lookup_kaspi_client`,
`refund_kaspi_payment`); payment confirmations arrive as system notifications in the thread.

### Sandbox

Same chat UI as production, isolated, with a version selector; tool events are visible.

### Model choice

None exposed to users. We will expose OpenRouter models.

## 5. Knowledge base

- **Documents**: upload (PDF, DOCX, XLS/XLSX, ODS, ODT, TXT, JSON, RTF; 20 MB), Google Docs,
  Google Sheets, Website (single page or crawl → markdown), Instagram, МойСклад. Checkbox
  "Use AI-powered intelligent processing" splits a document into logical blocks (price list →
  items, catalogue → categories). Statuses processing / indexed / error; per-document reindex.
- **Items** (47 in the sample): type Product, Q&A, Procedure, Contact, File, Other; title ≤200,
  content ≤8000, attachments (files ≤40 MB or URL + name). Each image attachment gets an
  AI-written description, which is how the agent picks the right photo to send. Items show
  their origin ("File: Website – …" or "Manually created"). Search, per-type tabs, pagination.
- Answers cite **Sources**; if nothing matches, the agent says it cannot answer.
- Cache must be cleared after KB changes ("Clear cache" in Settings).

## 6. Meta Conversions API

Two datasets, configured under Integrations → Meta Conversions API:

1. **Pixel / Dataset** for the website channel: Pixel ID (dataset id), CAPI access token
   (stored encrypted), purchase currency (or "not set" to send events without value). Saving
   validates the pair against Meta. "Send test event" sends a Lead event with a test event code.
2. **WhatsApp ads tracking**: "Purchases from ads that open WhatsApp are reported to Meta through
   a separate dataset tied to your WhatsApp number. Pleep creates it for you." Shown with its own
   dataset id and an "Update token" button. This is Meta's CAPI for Business Messaging: events
   carry `ctwa_clid` from the inbound message `referral`, so only leads that arrived from a
   Click-to-WhatsApp ad can be sent.

Events are sent when a lead enters the sale stage (hence the "one sale stage" rule) or manually
from the lead card. No Marketing API / Ads Manager sync exists; attribution comes entirely from
the webhook referral.

## 7. Statistics

Filters: period, outcome, channel, campaign (broadcast campaigns), export. Analytics settings:
free-text **primary goal** of the agent and a conversion cycle in days; conversion = share of
chats that reached the goal. Blocks: outcomes (conversion, inconclusive closed, no customer
response), engagement (dialogs, AI responses main vs follow-ups, avg customer messages, quota),
speed (AI and human response time, chats where AI asked for help), trends, **sales funnel** (a
lead counts in every stage it passed), lead sources, UTM sources, team table, lead insights
(clustered drop-off reasons and conversion drivers). Operator analytics: SLA, first response,
resolution, per-operator table, per-conversation attribution.

## 8. Public API and webhooks (for parity later)

Base `https://microservice.pleep.app/api/v1/`, header `X-API-Key`. Endpoints: send-template,
get-threads (threads with `message_handler` AI|OPERATOR, `lead_status {id,name,kind,order}`,
messages with role AI|USER|OPERATOR), leads get-statuses / get-lead / set-status. Outgoing
webhooks `lead.status_changed` and `crm.status_changed`, HMAC-SHA256 over
`${timestamp}.${rawBody}`, 5 retries with backoff, HTTPS only.

## 9. What we do differently

- Cloud API with a dedicated number and hand-pasted credentials instead of Embedded Signup.
- Manual "paid" mark instead of Kaspi tools at first.
- User-selectable OpenRouter model per workspace.
- No Instagram, Telegram, widget, voice, broadcasts, CRM extensions in the first passes.
