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
}

/** What to paste into the Meta application's webhook settings. */
export interface WebhookSetup {
  url: string;
  verifyToken: string;
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
