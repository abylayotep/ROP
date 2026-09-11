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
  /** Null for a linked device: Meta issued no id, because Meta was never involved. */
  phoneNumberId: string | null;
  wabaId: string | null;
  /** As Meta formats it, for a human to recognise. */
  displayPhone: string;
  enabled: boolean;
  /** False means Meta accepted the number but will not deliver anything yet. */
  subscribed: boolean;
  connectedAt: string;
  /**
   * 'manual' — pasted ids and token. 'coexistence' — the phone's number via Embedded Signup.
   * 'linked' — the phone's number through a linked device, outside Meta entirely.
   */
  connectionKind: 'manual' | 'coexistence' | 'linked';
  /** Linked only: how the pairing stands. Null for the two Cloud API kinds. */
  linkedState: 'pairing' | 'open' | 'logged_out' | null;
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
  /** The `ai_replies` row this message was the agent's output of. Null for an inbound
   * customer message and for an operator's own line — neither is a reply `coach.ts`'s
   * `ownReply` would ever resolve — and null for an AI message from before this column
   * existed. Carried so «Так нельзя» can name the exact turn a wrong answer came from,
   * rather than the coach guessing the conversation's latest reply. */
  aiReplyId: string | null;
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
 * What the agent answers from: a vault of notes, the sections they split into,
 * and the links between them. */

export type KbNoteKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';

/** A note as a list or a tree shows it: enough to draw a row, not the body. */
export interface KbNote {
  id: string;
  /** «Товары/Двери входные». Folders are the segments before the last slash. */
  path: string;
  title: string;
  kind: KbNoteKind;
  tags: string[];
  edited: boolean;
  sourceId: string | null;
  sourceTitle: string | null;
  updatedAt: string;
}

/** One section of a note: what search ranks and what the agent quotes. */
export interface KbSection {
  id: string;
  noteId: string;
  /** «Доставка › По городу», so an answer says where in the note to look. */
  title: string;
  heading: string;
  content: string;
}

export interface KbLinkRef {
  noteId: string | null;
  title: string;
}

/** A note opened: its text, its sections, and what points at it. */
export interface KbNoteDetail extends KbNote {
  body: string;
  sections: KbSection[];
  /** Notes that link here. */
  backlinks: KbLinkRef[];
  /** What this note links to. `noteId` null is a link whose target does not exist. */
  links: KbLinkRef[];
}

/** The graph tab. Capped at 500 notes; `truncated` says the cap was hit. */
export interface KbGraph {
  notes: { id: string; title: string; path: string }[];
  links: { from: string; to: string }[];
  truncated: boolean;
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
  notes: KbNote[];
  /**
   * True when this went onto a source that already existed — «Обновить», or a page address
   * this agent had already imported. The screen words those two outcomes apart: a first
   * import created its notes, an update answers with everything the source holds now.
   */
  reimported: boolean;
  /**
   * How many of `notes` a person had edited, which an update keeps untouched.
   *
   * Answered rather than inferred from `notes`, because the screen must say it in words: a
   * kept note and a fresh one from the same page can now contradict each other, and the only
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

/* ── Правила и коуч ──────────────────────────────────────────────────────────
 * The agent's character used to be one paragraph in `instructions`. It is now a set of
 * rules the owner writes or approves in a coaching chat — this section names both. */

export type RuleCategory = 'business' | 'tone' | 'order' | 'forbid';

/** One rule the agent follows. The four categories are how the prompt groups them. */
export interface AgentRule {
  id: string;
  category: RuleCategory;
  text: string;
  enabled: boolean;
  /** 'manual' is what the owner typed, 'coach' is what they approved in the chat. */
  origin: 'manual' | 'coach';
  position: number;
  /**
   * Meant to be set when the owner keeps a rule the fact check wanted to be a note — shown
   * beside the rule, because a number in instructions is a number no record backs. No writer
   * exists yet: `POST /rules` does not accept it, and the «Всё равно правилом» escape hatch
   * this field was meant to back was never built. Kept so the plan that does build it does not
   * also need to add the field.
   */
  warning: string | null;
  updatedAt: string;
}

/** What the coach suggests. It writes nothing: a proposal becomes a draft or it is rejected. */
export type CoachProposal =
  | { kind: 'rule'; category: RuleCategory; text: string }
  | { kind: 'rule_edit'; ruleId: string; text?: string; enabled?: boolean }
  | { kind: 'note'; path: string; body: string }
  | { kind: 'note_edit'; noteId: string; body: string };

export interface CoachMessage {
  id: string;
  role: 'owner' | 'model';
  text: string;
  proposal: CoachProposal | null;
  /** Why the fact check moved a rule into a note, when it did. */
  warning: string | null;
  status: 'pending' | 'drafted' | 'rejected';
  /** Set once the proposal became a draft. The drafts plan fills this in. */
  draftId: string | null;
  conversationId: string | null;
  createdAt: string;
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
   * writing rules cannot act on.
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

/**
 * How far back a usage answer looks. The screen offers exactly these three.
 *
 * Kept as its own name because the AI screen imports it; it is `Period` — the расход card
 * and the statistics cards ask the same question of the same three buttons.
 */
export type AiUsagePeriod = Period;

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

/* ── Статистика ─────────────────────────────────────────────────────────────
 * Где сейчас стоят лиды и что с ними происходило за период. Две карточки, не
 * одна: снимок на сейчас считает всё, что вообще было, а движение по воронке
 * записывается только с того дня, когда кабинет начал его записывать. */

/**
 * How far back a report looks. The screen offers exactly these three, everywhere.
 *
 * Rolling windows of 1, 7 and 30 days, not calendar ones — `server/src/lib/period.ts` says
 * why, and is the only place that turns one of these into a date.
 */
export type Period = 'day' | 'week' | 'month';

/** One stage of the funnel with how many leads are standing in it right now. */
export interface StageStanding {
  stageId: string;
  name: string;
  color: string;
  kind: StageKind;
  position: number;
  /** Conversations whose `stageId` is this one. Zero here is a fact, not an absence. */
  leads: number;
}

/**
 * Where every lead of the agent stands at this instant.
 *
 * No period, and the absence is load-bearing: this counts every conversation the cabinet
 * has ever had, including the ones triaged before it began recording movement, and it is
 * the card that answers «почему воронка пустая, у меня двести лидов».
 */
export interface StatsCurrent {
  /** Every current stage in `position` order, including the ones holding nobody. */
  stages: StageStanding[];
  /** Leads nobody has triaged — no stage at all. */
  unsorted: number;
  /** Every conversation of the agent: the stages plus `unsorted`, and nothing else. */
  total: number;
  // No `stageHistorySince` here, deliberately. This card has no period and never prints
  // that date; the card that does — the period report — carries its own copy, answered
  // from the same column in the same request. A second copy nobody renders is a field that
  // drifts without anyone noticing.
}

/**
 * One step of the funnel over a period: how many leads entered it, and out of how many.
 *
 * A step counts a lead once, however many times it entered the stage in the window, and it
 * counts only the leads that actually entered — a lead dragged past a stage is absent from
 * it. That is why `entered` may rise from one step to the next, and why the chain must not
 * be read as a set of nested totals.
 */
export interface FunnelStep {
  stageId: string;
  name: string;
  kind: StageKind;
  position: number;
  /** Distinct conversations that entered this stage inside the window. */
  entered: number;
  /**
   * Share of the nearest earlier step anyone entered — and `null`, never `0`, without one.
   *
   * The denominator skips the stages nobody was routed through, because an owner's stage
   * list is longer than most deals need and a stage nobody used is ordinary. Dividing by
   * the row above instead would print «0%» on the skipped stage — read as «каждая сделка
   * умирает здесь» about a stage where nothing was ever attempted — and would then silence
   * the real stage underneath it.
   *
   * Null in exactly two cases: this step has no entries of its own, so there is no share to
   * state; or nobody entered any earlier step, so there is nothing to be a share of.
   *
   * Can exceed 1. A lead dragged straight into this stage past the one above never entered
   * that one, so a step may hold more leads than its denominator. The screen prints what
   * happened rather than capping it.
   */
  conversion: number | null;
}

/** One advertisement, with what it brought over the period. */
export interface StatsSource {
  /**
   * The ad this thread came from, or `null` for a click that carried no ad id.
   *
   * The `null` row is one row and not a missing one: the click happened and is worth
   * counting, and the screen labels it «Реклама без идентификатора объявления».
   */
  sourceId: string | null;
  /**
   * Null unless the whole group agrees.
   *
   * The `sourceId: null` row holds clicks from *different* advertisements, and naming one
   * of them would credit its leads to an ad they never saw. A row that means «клики,
   * рекламу которых не удалось определить» carries no name at all.
   */
  sourceType: string | null;
  headline: string | null;
  /** Conversations of this ad created inside the window. */
  leads: number;
  /** Of those, the ones carrying a `ctwa_clid` — the id a purchase can be reported against. */
  withClickId: number;
  /** Of those, the ones standing right now in a stage of kind `success`. */
  won: number;
  /**
   * A string, not a number: an amount must not pass through a float, for the reason
   * `Order.amount` is a string.
   *
   * Every paid order of those conversations, whenever it was paid — so a lead who clicked
   * inside the window and paid a month later still credits the ad that brought them.
   */
  paidTotal: string;
}

/**
 * What the window's leads paid, in the agent's own currency.
 *
 * One population, and it is the same one `StatsSource` counts: the conversations created
 * inside the window, with **every** paid order of theirs whenever it was paid. Not the
 * orders paid inside the window, which would divide a March lead's payment by this week's
 * new threads and disagree with the ad table standing right beneath it. The cost is stated
 * on the screen instead of hidden: a past period's total can grow when a payment lands
 * late.
 *
 * Null on the report — never a row of zeros — exactly when the cohort has no paid order at
 * all, in any currency.
 */
export interface StatsMoney {
  /** Paid orders of the cohort held in the agent's currency. */
  paidOrders: number;
  /** A string, not a number: an amount must not pass through a float. */
  paidTotal: string;
  /** A string, not a number. Null when there is nothing to average. */
  averageOrder: string | null;
  /**
   * `paidTotal` over every conversation created in the window, a string, not a number.
   *
   * Null — not «0 ₸ с лида» — when the cohort paid nothing in the agent's currency, which
   * is the only way the numerator can be absent: an order of the cohort implies a lead in
   * it, so the denominator is never zero here.
   */
  revenuePerLead: string | null;
  /**
   * Paid orders of the cohort held in some other currency, excluded from every sum above.
   *
   * Counted rather than dropped, so an excluded amount is visible instead of merely
   * missing — and so a window whose paid orders are *all* foreign still reports money
   * rather than «за период нет оплаченных заказов», which would be false.
   */
  otherCurrencyOrders: number;
}

/**
 * The funnel, the ad sources and the money for one rolling window.
 *
 * Two of the three are honest about the whole history of the agent and one is not, and the
 * split is the point of `stageHistorySince` being here: sources and money have been recorded
 * since the number was connected, while movement between stages starts on the day the
 * cabinet began writing it down.
 */
export interface StatsPeriodReport {
  period: Period;
  /** The instant the window starts, ISO, computed on the server. */
  since: string;
  /** When the cabinet began recording movement, ISO. The funnel knows nothing before it. */
  stageHistorySince: string;
  /**
   * Every current stage of kind other than `failure`, in `position` order — and empty
   * exactly when nothing moved at all inside the window.
   *
   * `failure` is out of the chain deliberately: «Отказ» sits after «Продажа» by position,
   * and a chain that walked through it would read a refusal as a step towards a sale. It is
   * reported beside the chain as `failureEntries`.
   */
  funnel: FunnelStep[];
  /**
   * Distinct conversations that entered a refusal inside the window.
   *
   * A stage is a refusal by its **kind now**, which is what keeps it out of `funnel` — the
   * two read the same source of truth, so a stage the owner re-marks moves between them
   * rather than falling out of both or being counted by both. A stage that no longer
   * exists is judged by the kind recorded on the transition, the only truth left about it.
   */
  failureEntries: number;
  /** Moves to an earlier position — per move, because how often it happens is the question. */
  backwardMoves: number;
  /** Moves into a stage that has since been deleted, which therefore has no column above. */
  deletedStageEntries: number;
  /** The names those deleted stages had, at most ten of them. */
  deletedStageNames: string[];
  /** Conversations created inside the window. */
  newLeads: number;
  /** Of those, the ones that arrived from an advertisement. */
  leadsFromAds: number;
  sources: StatsSource[];
  /** Null exactly when the window holds no paid order: a row of zeros would read as a fact. */
  money: StatsMoney | null;
  currency: string;
}

/* ── Черновики и прогоны ────────────────────────────────────────────────────
 * A proposed change to the agent — a draft — proven against a case set before it lands. A
 * draft's own run is asynchronous: `POST .../drafts/:draftId/runs` answers with `status:
 * 'running'` before a single case has been replayed, and a screen polls `GET .../runs/:runId`
 * to watch `results` gain a row per case. */

/** One write a draft would make, applied for real only once the draft is applied. */
export type DraftOp =
  | { op: 'note_create'; path: string; body: string }
  | { op: 'note_update'; noteId: string; body: string }
  | { op: 'rule_create'; category: RuleCategory; text: string; warning?: string | null }
  | { op: 'rule_update'; ruleId: string; text?: string; enabled?: boolean };

/** A change waiting to be proven. It is applied only after a run at the current version. */
export interface KbDraft {
  id: string;
  title: string;
  origin: 'coach' | 'manual';
  status: 'open' | 'applied' | 'discarded';
  ops: DraftOp[];
  createdAt: string;
  appliedAt: string | null;
}

/** One run in a draft's own history, as `GET .../drafts/:draftId` lists it — enough for a
 * screen to say «прогнан тогда-то» without guessing, and to reopen the full `TestRun` (with
 * its per-case results) through `GET .../runs/:runId` by `id`. Newest first. */
export interface DraftRunSummary {
  id: string;
  status: 'running' | 'done' | 'failed';
  configVersion: number;
  draftCost: string;
  baselineCost: string;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * `GET .../drafts/:draftId`'s own answer — `KbDraft` plus what a reload needs and cannot
 * otherwise know: the draft's run history, and whether it is provably safe to apply *right
 * now*. `applicable` is exactly the predicate the apply route itself checks (a `done` run at
 * the agent's current `config_version`), computed by the one function both share — so a
 * screen's «Применить» can never disagree with what the apply route would actually do.
 */
export interface KbDraftDetail extends KbDraft {
  runs: DraftRunSummary[];
  applicable: boolean;
}

export interface TestCase {
  id: string;
  title: string;
  /** The customer's side only. The agent's replies are what is being tested. */
  messages: string[];
  expectation: string | null;
  origin: 'manual' | 'dialog' | 'generated';
  conversationId: string | null;
  enabled: boolean;
  updatedAt: string;
}

/**
 * One case the model suggested for a draft, from `POST .../drafts/:draftId/suggest-cases`.
 *
 * Nothing here is saved — the route that returns it writes no `test_cases` row. A set that
 * grows by itself is a set nobody trusts, so this is only ever what the owner is offered to
 * post back through `POST .../test-cases`, one at a time or not at all.
 */
export interface SuggestedCase {
  title: string;
  messages: string[];
}

/** One side of a comparison — «было» or «стало» — as a run reports it. */
export interface TestCaseSide {
  reply: string | null;
  usedChunkIds: string[];
  stageId: string | null;
  handoff: boolean;
  handoffReason: string | null;
  /** The `TurnOutcome` the replay ended in. */
  outcome: string;
  /** In US dollars, as OpenRouter reported it. */
  cost: string;
  /** Whether *this* run is what paid for this side, or an existing baseline answered it — see
   * `TestRun.baselineCost`'s own comment. */
  origin: 'paid' | 'reused';
}

/** One row of the «было — стало» table. `before` is null when the case is new to the set —
 * no baseline has ever answered it. */
export interface TestComparison {
  caseId: string;
  before: TestCaseSide | null;
  after: TestCaseSide;
  /** The model's hint. It gates nothing — the owner presses the button. */
  verdict: 'better' | 'worse' | 'same' | null;
  verdictReason: string | null;
}

/**
 * One pass over a set of cases. `draftId` null is a baseline run: the agent as the store
 * stands, replayed with no draft ops at all.
 *
 * `status` is `'running'` from the instant the run is admitted, before any case has a result —
 * a screen polls `GET .../runs/:runId` and watches `results` fill until it leaves `'running'`.
 */
export interface TestRun {
  id: string;
  draftId: string | null;
  configVersion: number;
  model: string;
  status: 'running' | 'done' | 'failed';
  /** «Стало» — the draft's own ops applied. Paid for every case, every run, in US dollars. */
  draftCost: string;
  /** «Было». Zero when every case reused an existing baseline rather than paying for a fresh
   * one — see each row's own `before.origin` for which case paid and which was reused. */
  baselineCost: string;
  results: TestComparison[];
  startedAt: string;
  finishedAt: string | null;
}
