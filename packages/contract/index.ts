/**
 * The shapes the server sends and the cabinet reads. Both sides import this file, so a
 * response cannot drift from what the screen expects without the compiler noticing.
 *
 * Types arrive with the endpoints that emit them: conversations in stage 2, orders in
 * stage 3, and so on. Nothing lives here ahead of a route that returns it.
 */

export type Role = 'owner' | 'member';

/** An account the signed-in person belongs to, with their powers in it. */
export interface Account {
  id: string;
  name: string;
  role: Role;
}

export interface Agent {
  id: string;
  accountId: string;
  name: string;
  description: string;
  timezone: string;
  /** ISO 4217. Every order this agent records is in it. */
  currency: string;
}

/** The signed-in person and where they may go. Returned by login and by /auth/me. */
export interface Me {
  name: string;
  initials: string;
  email: string;
  accounts: Account[];
}

/* ── WhatsApp ───────────────────────────────────────────────────────────────
 * A connected number, and what the owner must paste into Meta to connect one. */

export interface WhatsappNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  /** As Meta formats it, for a human to recognise. */
  displayPhone: string;
  enabled: boolean;
  /** False means Meta accepted the number but will not deliver anything yet. */
  subscribed: boolean;
  connectedAt: string;
  /** 'manual' — pasted ids and token. 'coexistence' — the phone's number via Embedded Signup. */
  connectionKind: 'manual' | 'coexistence';
  /** 0..100. Meaningful for coexistence only; manual numbers stay at 0. */
  historyProgress: number;
  /** The owner turned history sharing off on the phone. */
  historyDeclined: boolean;
  /** Meta's words when a sync request was refused, else null. */
  syncError: string | null;
  /** The phone disconnected the API; reconnect happens on the phone, not here. */
  offboarded: boolean;
}

/** What to paste into the Meta application's webhook settings. */
export interface WebhookSetup {
  url: string;
  verifyToken: string;
}

/** What the browser needs to start Embedded Signup. Nothing secret. */
export interface EmbeddedSignupSetup {
  appId: string;
  configId: string;
}

/** What Embedded Signup hands back, forwarded to the server within the code's 30 seconds. */
export interface CoexistenceConnection {
  code: string;
  wabaId: string;
  phoneNumberId?: string;
  businessId?: string;
}

export interface Message {
  id: string;
  /** 'in' | 'out' */
  direction: string;
  /** 'client' | 'operator' | 'ai' | 'system' — 'system' is the cabinet's own auto-message. */
  author: string;
  /** WhatsApp's own type: text, image, audio, video, document, sticker, location, … */
  kind: string;
  body: string | null;
  /** True when a file is stored for this message and can be fetched. */
  hasMedia: boolean;
  mediaMime: string | null;
  /** Outbound only: sent, delivered, read, failed. */
  status: string | null;
  sentAt: string;
}

export interface ConversationSummary {
  id: string;
  contactName: string | null;
  contactPhone: string;
  lastMessageAt: string | null;
  /** The last line, for the list. */
  preview: string | null;
  /** Whether a free-form reply is still allowed. */
  windowOpen: boolean;
  /** Null when the conversation did not come from an ad. */
  adHeadline: string | null;
}

export interface ConversationThread extends ConversationSummary {
  messages: Message[];
}

/* ── Воронка ────────────────────────────────────────────────────────────────
 * The funnel an owner shapes, and the fields it asks to be filled. */

export type StageKind = 'active' | 'qualified' | 'awaiting_payment' | 'success' | 'failure';

export interface Stage {
  id: string;
  name: string;
  /** A hex colour, shown as the column's marker. */
  color: string;
  kind: StageKind;
  position: number;
  /** When a lead belongs here, in the owner's own words. Read by the agent in stage 5. */
  description: string;
  /** Sent on entering the stage. Null means the stage sends nothing. */
  autoMessage: string | null;
}

export type LeadFieldKind = 'text' | 'number' | 'date';

export interface LeadField {
  id: string;
  name: string;
  kind: LeadFieldKind;
  /** How to fill it, for the agent in stage 5. Never shown to an operator. */
  hint: string;
  position: number;
}

/* ── Лид ────────────────────────────────────────────────────────────────────
 * A conversation seen as a sale in progress. */

export interface LeadFieldValue {
  fieldId: string;
  value: string;
}

export interface Note {
  id: string;
  body: string;
  /** Null for the lines the cabinet writes itself. */
  authorName: string | null;
  createdAt: string;
}

export interface Order {
  id: string;
  /** A string, not a number: an amount must not pass through a float. */
  amount: string;
  currency: string;
  status: 'pending' | 'paid' | 'cancelled';
  comment: string;
  paidAt: string | null;
  createdAt: string;
}

export interface Lead {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  stageId: string | null;
  stageSetAt: string | null;
  /** 'operator' | 'ai' | 'scenario' | 'system' */
  stageSetBy: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  adHeadline: string | null;
  /**
   * Whether this conversation carries the click identifier Meta attributes a purchase to.
   *
   * Not the same question as `adHeadline`: a referral without a `ctwa_clid` still names the
   * ad for a human reading the thread, and it is exactly that case — an ad is named, nothing
   * can be reported — that the lead card would otherwise get wrong. The identifier itself
   * never leaves the server; whether there is one is all a screen needs.
   */
  fromAd: boolean;
  /**
   * Whether the agent still answers on this thread. On by default, and off the moment a
   * handoff or an operator takes it — which is why it travels with the lead: the panel that
   * offers the switch is the one that has to show it already flipped.
   */
  aiEnabled: boolean;
  values: LeadFieldValue[];
  notes: Note[];
  orders: Order[];
  /** The sum of this lead's paid orders, as a string with two decimals. */
  paidTotal: string;
  currency: string;
}

/** Someone in the account, for the assignee list. */
export interface Member {
  id: string;
  name: string;
  initials: string;
  role: Role;
}

/* ── Доска и клиенты ────────────────────────────────────────────────────────
 * The funnel seen as columns, and everyone who ever wrote seen as a table. */

export interface BoardCard {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessageAt: string | null;
  preview: string | null;
  /** Whether a free-form reply is still allowed. */
  windowOpen: boolean;
  adHeadline: string | null;
  /** The sum of this lead's paid orders, as a string with two decimals. */
  paidTotal: string;
  assigneeName: string | null;
}

export interface BoardColumn {
  stage: Stage;
  cards: BoardCard[];
}

export interface Board {
  columns: BoardColumn[];
  /** Conversations nobody has put in a stage yet. Shown first, never hidden. */
  unsorted: BoardCard[];
  currency: string;
}

export interface Customer {
  conversationId: string;
  contactName: string | null;
  contactPhone: string;
  stageName: string | null;
  stageKind: StageKind | null;
  paidTotal: string;
  orderCount: number;
  lastMessageAt: string | null;
  firstSeenAt: string;
  assigneeName: string | null;
}

/* ── База знаний ────────────────────────────────────────────────────────────
 * What the agent answers from. One row is one retrievable answer. */

export type KbItemKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';

export interface KbItem {
  id: string;
  kind: KbItemKind;
  title: string;
  content: string;
  /** True once a person has changed it. A reimport keeps these and replaces the rest. */
  edited: boolean;
  sourceId: string | null;
  /** The import this came from, for the screen. Null for a hand-written item. */
  sourceTitle: string | null;
  updatedAt: string;
}

export type KbSourceKind = 'text' | 'page';

export interface KbSource {
  id: string;
  kind: KbSourceKind;
  title: string;
  url: string | null;
  /**
   * Both imports are synchronous: the request fetches, splits and writes before it answers,
   * so a source is `ready` or it is `failed` and there is no moment in between for a third
   * value to describe. A `pending` nobody writes is a state the screen would have to render
   * and nobody would ever see.
   */
  status: 'ready' | 'failed';
  /** Why it failed, in the operator's language. Null when it did not. */
  error: string | null;
  itemCount: number;
  createdAt: string;
}

/** What an import produced, answered by the import routes so the owner sees it at once. */
export interface KbImport {
  source: KbSource;
  items: KbItem[];
  /**
   * True when this went onto a source that already existed — «Обновить», or a page address
   * this agent had already imported. The screen words those two outcomes apart: a first
   * import created its items, an update answers with everything the source holds now.
   */
  reimported: boolean;
  /**
   * How many of `items` a person had edited, which an update keeps untouched.
   *
   * Answered rather than inferred from `items`, because the screen must say it in words: a
   * kept item and a fresh one from the same page can now contradict each other, and the only
   * honest thing to do is name how many records the owner should go and check.
   */
  keptEdited: number;
}

/* ── Агент ──────────────────────────────────────────────────────────────────
 * What the owner may set about the model, what they may pick, and what one
 * sandbox turn answers back. The key is not here: it goes in and never out. */

export interface AiSettings {
  /** The agent answers customers only when this is on. A new agent starts off. */
  aiEnabled: boolean;
  /** An OpenRouter model id, one of `AiModel.id`. */
  model: string;
  /**
   * 0…2. A number rather than a string: a temperature is a dial, not an amount, so
   * nothing is lost by passing it through a float the way an order's sum would be.
   */
  temperature: number;
  /** What the owner wrote about how their business sells. The agent's whole character. */
  instructions: string;
  /** 'auto' answers in the customer's own language; anything else names one. */
  replyLanguage: string;
  /** Whether a key is stored. The key itself never leaves the server. */
  keySet: boolean;
}

/** A model the owner may pick, with the line they read while picking. */
export interface AiModel {
  id: string;
  label: string;
  description: string;
}

/** A knowledge record an answer was built from, named so the screen can show which. */
export interface AiTurnItem {
  id: string;
  title: string;
}

/** A lead field the turn filled, or would have filled. */
export interface AiTurnField {
  id: string;
  name: string;
  value: string;
}

/**
 * What a sandbox turn would have done. Nothing in it has happened: no message was sent,
 * no lead was touched, and the conversation it ran on no longer exists.
 */
export interface AiTurn {
  /** Null when the agent produced no reply, or when the reply was withheld. */
  reply: string | null;
  usedItems: AiTurnItem[];
  /** The stage the lead would be moved to. Null when it would not move. */
  stageName: string | null;
  fields: AiTurnField[];
  /**
   * Why the turn would leave the conversation to a person, or null when it would not. The
   * reason and not a flag: «передал человеку» with no «почему» is the one answer an owner
   * tuning instructions cannot act on.
   */
  handoff: string | null;
  /** 'sent' | 'unrecorded' | 'applied' | 'handoff' | 'failed' | 'skipped'. */
  outcome: string;
  /** Why it ended that way, when that is worth telling the owner. Never carries a key. */
  detail: string | null;
}

/* ── Расход агента ──────────────────────────────────────────────────────────
 * Что стоили ответы агента за период — чтобы выбор модели можно было сравнить
 * с ценой, а не только с ощущением. Строится по журналу ответов. */

/** How far back a usage answer looks. The screen offers exactly these three. */
export type AiUsagePeriod = 'day' | 'week' | 'month';

/** One period's turns, counted by how they ended, with what they spent. */
export interface AiUsageTotals {
  /** Every turn that reached the model, however it ended. */
  turns: number;
  /** Reached the customer. */
  sent: number;
  /** Left to a person — the model asked, or the cabinet withheld the reply. */
  handoff: number;
  /** Produced nothing: OpenRouter refused, or the reply never left. */
  failed: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * What OpenRouter charged, in US dollars, as a string.
   *
   * A string end to end for the same reason an order's amount is one: summed in Postgres
   * as `numeric` and read back as text, so a fraction of a cent per turn is never rounded
   * through a float on its way to the screen.
   */
  cost: string;
}

/** The same counts for one model, so two models can be compared side by side. */
export interface AiUsageModel extends AiUsageTotals {
  /** An OpenRouter model id. It may be one no longer offered — the log keeps what ran. */
  model: string;
}

export interface AiUsage {
  period: AiUsagePeriod;
  /** The moment the period starts, ISO. The screen names it rather than implying it. */
  since: string;
  /**
   * Null when the agent took no turns in the period.
   *
   * Null and not a row of zeros: an owner who has not switched the agent on would read
   * «0 $» as a fact about their model instead of the absence of any fact at all.
   */
  total: AiUsageTotals | null;
  /** One row per model that ran, busiest first. Empty exactly when `total` is null. */
  byModel: AiUsageModel[];
}

/* ── Meta Conversions API ───────────────────────────────────────────────────
 * Куда уходят покупки из переписки и что с ними стало. Токен сюда не попадает:
 * он уходит на сервер и обратно не возвращается — только признак, что он есть. */

/**
 * The dataset an agent's conversions go to, and whether they go at all.
 *
 * The access token is deliberately absent. It is stored encrypted and never leaves the
 * server; `tokenSet` is the only thing a screen may know about it — the same arrangement
 * `WhatsappNumber` and `AiSettings` use for their secrets.
 *
 * An agent that has never configured this is answered a blank one — `datasetId: ''`,
 * `tokenSet: false` — rather than null, so the form has something to render either way.
 */
export interface CapiSettings {
  /** Meta's dataset (pixel) id. Empty exactly when nothing has been configured yet. */
  datasetId: string;
  /** Meta's test event code, while an owner is watching Events Manager. Usually null. */
  testEventCode: string | null;
  enabled: boolean;
  /** Whether an access token is stored. The token itself never leaves the server. */
  tokenSet: boolean;
  /** When the dataset and the token were last proved against Meta, ISO. */
  verifiedAt: string | null;
  /** What Meta last said when it refused the pair, or null. */
  error: string | null;
}

/**
 * One thing that was reported to Meta, or was not, and why.
 *
 * `value` and `currency` come from the order the report is about, so a purchase can be
 * recognised by its amount; a lead carries neither. The contact is named so an owner
 * reading a failure knows whose sale it was — it is not part of what Meta receives.
 */
export interface CapiEvent {
  id: string;
  /**
   * The conversation the report is about, so the lead card can ask for its own events
   * instead of scanning the agent's log for a row that may have fallen off the end of it.
   * Null for a report whose conversation has since been deleted — the report still happened.
   */
  conversationId: string | null;
  /** 'purchase' | 'lead' */
  kind: string;
  /** 'pending' | 'sent' | 'failed' | 'skipped' */
  status: string;
  attempts: number;
  /**
   * Whether pressing «Отправить снова» has anything to send.
   *
   * False for the one row that can never go: a conversation that did not come from an ad
   * has no click identifier, nothing could be built for it, and the click is captured once
   * on the first message and cannot be recovered afterwards. The resend route refuses such
   * a row; this is what lets a screen explain that instead of offering a button that fails.
   */
  resendable: boolean;
  /**
   * Why it has not gone. Meta's own words for a refusal, in Meta's own English, because
   * «Invalid access token» is the whole answer and only the owner can act on it; ours, in
   * Russian, for the reasons the cabinet decided itself. Never carries the token.
   */
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  /** The order's amount as a string, or null for a lead. Never through a float. */
  value: string | null;
  currency: string | null;
  contactName: string | null;
  contactPhone: string | null;
}
