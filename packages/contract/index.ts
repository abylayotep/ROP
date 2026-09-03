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
  /** 'client' | 'operator' | 'ai' */
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
