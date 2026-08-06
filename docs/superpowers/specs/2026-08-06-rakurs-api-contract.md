# API contract and frontend changes

Part of [Rakurs — Production Readiness](2026-08-06-rakurs-production-design.md).

The rule for the cleanup: **numbers and enums cross the wire; formatting and colour happen in
the browser; prose written by the model stays server-side.** `src/lib/format.ts` and
`src/lib/tone.ts` already exist for exactly the first two.

## Types that change

`src/types/index.ts` is the contract. Changes below, with the reason each one is not cosmetic.

**`Seller`** — `dialogs`, `sales`, `conv`, `reply` become numbers; `conv`/`convValue` and
`reply`/`replyMinutes` were the same fact twice, once formatted and once raw. `fix` stays: the
model writes it. Adds `id`.

```ts
interface Seller {
  id: string; initials: string; name: string;
  dialogs: number; sales: number; conversionPct: number; replyMinutes: number;
  score: number; fix: string;
}
```

**`WhatsAppNumber`** — `statusFg`, `dot`, `action` and the formatted `status` collapse into one
enum the frontend renders. `since` becomes ISO.

```ts
interface WhatsAppNumber {
  phone: string; owner: string; dialogs: number;
  state: 'linked' | 'waiting' | 'expired' | 'logged_out';
  linkedAt: string | null;
}
```

**`AdAccount`** — `statusFg` drops, `status` becomes an enum, `spendOverride?: string` becomes
`spend30d: number`.

**`Creative`** — `verdictLabel` drops (derivable from `verdict`); `verdictText` stays as model
prose. `capiTitle`/`capiMeta` become `capi: { sent: number; pending: number; failed: number }`.
`LabeledCount.count` becomes a number and `color` drops — tone follows from the value.

**`Dialog`** — the largest change, and the one that fixes a genuine bug in the making:

```ts
interface Dialog {
  id: string; client: string; city: string | null; channel: string;
  lastMessageAt: string;                       // ISO, was a pre-formatted `time`
  campaign: string | null;                     // null when unattributed
  group: string | null;
  creative: string | null;
  attributionSource: 'referral' | 'code' | 'manual' | null;
  ask: string; sent: string[]; forWhom: string; purpose: string;
  seller: string;
  outcome: 'bought' | 'lost' | 'in_progress';  // was DialogStatus 'Купил'|'Купила'|…
  clientGender: 'male' | 'female' | 'unknown';
  amount: number; score: number;
  outcomeTitle: string; outcomeText: string;   // model prose, was `outcome`
  draft: string; draftMeta: string;
  capi: { status: 'pending' | 'sent' | 'confirmed' | 'failed' | 'none';
          amount: number; sentAt: string | null };
  // `chat` is gone from the list — see below.
}
```

`DialogStatus` fused an outcome with a grammatical gender. Splitting them lets the frontend
decline `Купил`/`Купила` and lets the backend store a fact instead of a rendered word.

**Two fields swap meaning here, and a careless rename will cross them.** Today `status` holds the
outcome and `outcome` holds the model's prose. After the change `outcome` is the enum and the
prose is `outcomeText`. Rename `outcome` → `outcomeText` first, then `status` → `outcome`; doing
it in the other order silently overwrites one with the other, and both are strings, so nothing
fails to compile.

The nullable attribution fields are the contract's admission that some conversations have no
known source. Every screen consuming `creative`/`campaign` must render "источник не определён"
for null rather than an empty cell.

**`ChatMessage.gap`** — `gap?: string` becomes `gapMinutes?: number`.

**`BroadcastHistoryRow`, `BroadcastSegment`, `BroadcastTemplate`, `AgentConfig`** are left
untouched. Broadcasts and the agent are deferred, their screens render empty states, and
rewriting a contract nothing serves yet would be churn.

## Endpoints

Unchanged in shape, real data behind them: `/profile`, `/settings`, `/ad-accounts`,
`/creatives`, `/ads/insights`, `/ads/:id`, `/ads/bulk`, `/overview`, `/benchmarks`,
`/capi/reconciliation`, `/sellers`, `/sellers/activity`, `/whatsapp/*`, `/integrations`.

New:

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | Sessions. No login screen exists today. |
| `GET /api/dialogs/:id` | Full conversation, including `chat` |
| `POST /api/dialogs/:id/attribution` | Manual ad binding |
| `GET /api/ads/tracking-codes` | Ad → code → suggested prefilled text |
| `POST /api/payments/import` | Paste raw text, returns import id |
| `GET /api/payments/import/:id` | Poll parse status, get the preview rows |
| `POST /api/payments/import/:id/confirm` | Write payments, enqueue CAPI |
| `GET /api/payments?days=30` | Payment ledger |

`GET /api/dialogs` loses `chat`. Today it returns every message of every conversation in the
period — fine against fixtures, megabytes against real data, and the dialogs screen would spend
seconds parsing JSON before rendering its first row. The list carries a preview; the card
fetches the conversation when opened.

Every endpoint requires a session except `POST /api/auth/login`. Unauthenticated requests get
401 and the frontend routes to the login screen.

## Frontend work

| File | Change |
|---|---|
| `src/types/index.ts` | The contract above |
| `src/screens/SellersScreen.tsx`, `components/sellers/Heatmap.tsx` | Format `Seller` numbers locally |
| `src/screens/CreativesScreen.tsx`, `components/creatives/*` | Numeric `LabeledCount`, structured `capi`, derived verdict label |
| `src/screens/DialogsScreen.tsx` | Outcome enum + gender, nullable attribution, fetch conversation on open |
| `src/components/dialogs/DialogPanel.tsx` | Loading state for the conversation; `gapMinutes` |
| `src/screens/SettingsScreen.tsx` | `WhatsAppNumber` enum; new tracking-codes section |
| `src/lib/format.ts`, `src/lib/tone.ts` | Absorb the formatting and colour rules coming back from the server |
| `src/api/index.ts` | New calls |
| `src/App.tsx`, new `screens/LoginScreen.tsx` | Auth gate and login |
| New `screens/PaymentsScreen.tsx` | Paste, preview, confirm |
| `mock-server/**` | Migrate fixtures to the new contract |

`mock-server/` is not disposable. It is how the frontend gets developed without a database, a
Meta token or a linked phone, and letting it drift from the real contract removes that.

## Screens after this pass

| Screen | State |
|---|---|
| Обзор | Real, except insights that depend on deferred features |
| Креативы | Real end to end — spend from Meta, revenue from payments, CAPI counts |
| Диалоги | Real — live WhatsApp conversations with model analysis |
| Продавцы | Real — activity and response times computed from messages. One row until more numbers are linked, since launch is a single number |
| Настройки | Real — accounts, WhatsApp linking, tracking codes, integrations |
| Оплаты (new) | Real |
| Рассылки | Empty state, deferred |
| Агент | Empty state, deferred |
