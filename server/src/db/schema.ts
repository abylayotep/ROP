import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tenancy plus authentication, plus WhatsApp: connected numbers, contacts,
 * conversations and messages. Orders and knowledge arrive in their own plans, each
 * with its own migration, and each keyed by agent_id.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Always stored lowercased. Plain text rather than citext, which would mean
  // installing an extension for a single column.
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  initials: text('initials').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_expires_at_idx').on(t.expiresAt)],
);

/** A company. Everything else in the product hangs off one of these. */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who may see an account, and with which powers. Role lives here rather than on the
 * user: the same person can own one company and answer chats in another.
 */
export const accountMembers = pgTable(
  'account_members',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'owner' | 'member'. Text rather than a Postgres enum: adding a third role later
    // would otherwise need a migration that rewrites the type.
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    index('account_members_user_id_idx').on(t.userId),
  ],
);

/**
 * One AI sales rep: its own knowledge, script, funnel and channels. Every table from
 * the next stages carries `agent_id` and reaches the account through this row.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    timezone: text('timezone').notNull().default('Asia/Almaty'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_account_id_idx').on(t.accountId)],
);

/**
 * A WhatsApp number connected through the Cloud API.
 *
 * `phoneNumberId` is unique across the whole product, not per agent: it identifies the number
 * inside Meta, an incoming webhook carries only that, and two agents claiming one number would
 * make the routing ambiguous.
 */
export const whatsappNumbers = pgTable(
  'whatsapp_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phoneNumberId: text('phone_number_id').notNull().unique(),
    wabaId: text('waba_id').notNull(),
    displayPhone: text('display_phone').notNull(),
    // Encrypted with the credentials key. Never selected into an API response.
    accessToken: text('access_token').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Set when Meta confirms our application is subscribed to the WABA. Until then the
    // number is connected but silent, which is the failure this column makes visible.
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('whatsapp_numbers_agent_id_idx').on(t.agentId)],
);

/** A person who wrote to us. Digits only, the shape WhatsApp uses in `wa_id`. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    // WhatsApp's profile name. Absent until the person's first message carries it.
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('contacts_agent_phone_key').on(t.agentId, t.phone)],
);

/**
 * One thread: this client, on this number.
 *
 * The advertising columns are filled once, from the `referral` block on the first message of
 * a conversation that began with a click on an ad. They are what stage 6 reports to Meta, and
 * they cannot be recovered afterwards — the block never appears again.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    whatsappNumberId: uuid('whatsapp_number_id')
      .notNull()
      .references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
    // The 24-hour window for a free-form reply is measured from this.
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ctwaClid: text('ctwa_clid'),
    adSourceId: text('ad_source_id'),
    adSourceType: text('ad_source_type'),
    adHeadline: text('ad_headline'),
    adBody: text('ad_body'),
    referralSeenAt: timestamp('referral_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_number_contact_key').on(t.whatsappNumberId, t.contactId),
    index('conversations_agent_last_message_idx').on(t.agentId, t.lastMessageAt),
  ],
);

/**
 * One message either way.
 *
 * `waMessageId` is unique because Meta delivers the same webhook more than once by design;
 * the index is the whole defence against a duplicated thread.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Nullable because not every message has an id from WhatsApp: stage 3's system note on
    // a thread has never been sent, and stage 5's AI draft exists before anyone sends it.
    // Still unique — Postgres treats nulls as distinct, so many rows may hold null while
    // the deduplication of real ids is untouched.
    waMessageId: text('wa_message_id').unique(),
    // 'in' | 'out'
    direction: text('direction').notNull(),
    // 'client' | 'operator' | 'ai' — stage 5 adds a value here, not a column.
    author: text('author').notNull(),
    // WhatsApp's own type: text, image, audio, video, document, sticker, location,
    // contacts, or unsupported for anything we do not render.
    kind: text('kind').notNull(),
    body: text('body'),
    mediaPath: text('media_path'),
    mediaMime: text('media_mime'),
    // Outbound only: sent, delivered, read, failed.
    status: text('status'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt)],
);

/**
 * Every webhook delivery, exactly as it arrived.
 *
 * Stored before anything is parsed and before we answer 200. Meta retries only on a non-200,
 * so a parser that throws after we have answered would lose the message otherwise; here the
 * row stays with its error and can be parsed again.
 */
export const whatsappEvents = pgTable(
  'whatsapp_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    // Counted up when a pass claims the row, before the work starts. An event that always
    // throws stops being picked up once this reaches the cap, so a permanent failure does
    // not grow the queue a webhook delivery has to walk.
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('whatsapp_events_processed_at_idx').on(t.processedAt)],
);
