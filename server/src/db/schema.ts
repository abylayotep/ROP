import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
// Type-only, so this stays a leaf module at runtime. `capi_events.payload` holds the exact
// bytes sent to Meta, and the brand is what stops anything but `serialiseEvent` filling it.
import type { CapiEventBody } from '../lib/capi/events.js';

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
    // ISO 4217. One business, one currency: an order form that asks every time would
    // be asking a question the answer to which never changes.
    currency: text('currency').notNull().default('KZT'),
    // The agent answers customers only when this is on. Off is the state a new agent starts
    // in: an owner writes the instructions first and turns it on when the sandbox convinces
    // them, not before.
    aiEnabled: boolean('ai_enabled').notNull().default(false),
    // An OpenRouter model id, exactly as OpenRouter spells it.
    model: text('model').notNull().default('openai/gpt-4o-mini'),
    // numeric, not real: a temperature read back as a string cannot drift through a float,
    // and it is written into a request body as text anyway.
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.30'),
    // What the owner wrote about how their business sells. The whole of the agent's character.
    instructions: text('instructions').notNull().default(''),
    // 'auto' answers in the language the customer wrote in. Anything else is a language name
    // the instructions will carry verbatim.
    replyLanguage: text('reply_language').notNull().default('auto'),
    // Encrypted with the credentials key, the same way a WhatsApp token is. Never selected
    // into an API response.
    openrouterKey: text('openrouter_key'),
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
    // Nullable and `set null` on delete: a conversation nobody has triaged has no stage,
    // and removing a stage must not remove the customers who were standing in it.
    stageId: uuid('stage_id').references((): AnyPgColumn => stages.id, { onDelete: 'set null' }),
    stageSetAt: timestamp('stage_set_at', { withTimezone: true }),
    // 'operator' | 'ai' | 'scenario' | 'system'. Stage 5 adds a value, not a column.
    stageSetBy: text('stage_set_by'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    // The agent answers on this thread. An operator who steps in turns it off here rather
    // than for the whole agent — the rest of the funnel keeps working.
    aiEnabled: boolean('ai_enabled').notNull().default(true),
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
 * One column of the funnel.
 *
 * `description` is written for stage 5: it is the sentence the agent will read to decide
 * whether a conversation belongs here. Nothing in this stage reads it, and it is empty by
 * default rather than absent, so the editor never has to reason about null.
 *
 * Exactly one stage per agent may have kind `success`. That is a rule the API enforces
 * rather than a constraint here: a partial unique index would make the seeding order
 * matter and would fail an owner's reorder mid-transaction with a message nobody can read.
 */
export const stages = pgTable(
  'stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    // 'active' | 'qualified' | 'awaiting_payment' | 'success' | 'failure'
    kind: text('kind').notNull(),
    position: integer('position').notNull(),
    description: text('description').notNull().default(''),
    // Sent when a lead enters this stage. Null means the stage sends nothing.
    autoMessage: text('auto_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stages_agent_position_idx').on(t.agentId, t.position)],
);

/**
 * A field the business wants filled on every lead.
 *
 * `hint` is stage 5's instruction for filling it, the same way `stages.description` is.
 * An operator sees only the name.
 */
export const leadFields = pgTable(
  'lead_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // 'text' | 'number' | 'date'
    kind: text('kind').notNull(),
    hint: text('hint').notNull().default(''),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('lead_fields_agent_name_key').on(t.agentId, t.name)],
);

/**
 * What one lead answered for one field.
 *
 * Always text, whatever the field's kind: a field's type can be changed after values
 * exist, and rewriting stored answers on a type change loses more than formatting on
 * read ever costs.
 */
export const leadValues = pgTable(
  'lead_values',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => leadFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.fieldId] })],
);

/**
 * Money.
 *
 * Separate from the stage on purpose: a stage says where the customer is, an order says
 * how much and when. A second purchase from the same person is a second row here rather
 * than a first one overwritten, and stage 6 reports the row, because only the row knows
 * the amount and the time.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Read back as a string. A float cannot hold 1234567.89 and money must not round.
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    // 'pending' | 'paid' | 'cancelled'
    status: text('status').notNull().default('pending'),
    comment: text('comment').notNull().default(''),
    // Filled only by 'paid'. Stage 6 sends this as the event time.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_conversation_idx').on(t.conversationId),
    index('orders_agent_paid_at_idx').on(t.agentId, t.paidAt),
  ],
);

/**
 * The operator's own record on a lead, and the only place the cabinet writes to when it
 * cannot do what it was asked — an auto-message it could not send leaves its reason here.
 *
 * Never sent to the customer. `authorId` is null for the cabinet's own lines.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notes_conversation_created_idx').on(t.conversationId, t.createdAt)],
);

/**
 * Postgres's own search vector. Declared as a custom type because Drizzle has no `tsvector`,
 * and never written from here — the column is generated, so an item edited through any path
 * is indexed correctly by definition rather than by remembering to reindex it.
 */
const tsvector = customType<{ data: string; notNull: true }>({
  dataType: () => 'tsvector',
});

/**
 * An import: a block of text someone pasted, or a page we fetched.
 *
 * It exists so that a reimport can replace what it made. An item written by hand has no
 * source, which is why `kb_items.source_id` is nullable.
 */
export const kbSources = pgTable(
  'kb_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // 'text' | 'page'
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    // 'ready' | 'failed', and no default: both imports are synchronous, so every row is
    // written by a path that already knows which of the two it is. A default would be the
    // third value nobody writes, waiting for a screen to render a state that never happens.
    status: text('status').notNull(),
    // Why it failed, in the operator's language.
    error: text('error'),
    itemCount: integer('item_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    importedAt: timestamp('imported_at', { withTimezone: true }),
  },
  (t) => [index('kb_sources_agent_created_idx').on(t.agentId, t.createdAt)],
);

/**
 * One retrievable answer.
 *
 * A hand-written fact and a chunk of an imported page are the same thing to the agent, so
 * they are the same row. Two tables would mean two search paths and two ways to be stale.
 */
export const kbItems = pgTable(
  'kb_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Set null, not cascade: deleting an import must not delete the corrections someone
    // made to what it produced.
    sourceId: uuid('source_id').references(() => kbSources.id, { onDelete: 'set null' }),
    // 'product' | 'qa' | 'procedure' | 'contact' | 'other'
    kind: text('kind').notNull().default('other'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    // True once a person has changed it. A reimport replaces what it made, except these:
    // a price the owner corrected by hand outranks the page it came from.
    edited: boolean('edited').notNull().default(false),
    search: tsvector('search')
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')`,
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_items_agent_kind_idx').on(t.agentId, t.kind),
    index('kb_items_search_idx').using('gin', t.search),
  ],
);

/**
 * One turn the model took, whether or not it produced a message.
 *
 * It exists so an owner choosing a model can see what the choice costs, and so a bad answer
 * can be traced to the records it was built from. The reply text is not duplicated here —
 * `messageId` points at the message that was actually sent, and is null when the turn ended
 * in a handoff or a failure.
 */
export const aiReplies = pgTable(
  'ai_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    // What OpenRouter says the turn cost, in US dollars. A string for the same reason an
    // order's amount is one.
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    // 'sent' | 'unrecorded' | 'applied' | 'handoff' | 'failed' | 'skipped'. `TurnOutcome`
    // in `lib/ai/turn.ts` is the list, and says what each one means to a caller deciding
    // whether the turn may be run again.
    outcome: text('outcome').notNull(),
    // Why it ended that way, when it was not 'sent'. Never carries a key.
    detail: text('detail'),
    // The knowledge records the reply was built from, so a wrong answer leads to the record
    // that produced it.
    // Typed at the column rather than cast at every read: the only thing that ever goes in
    // here is a list of knowledge item ids, and an `unknown` would make each caller assert
    // that separately.
    usedItemIds: jsonb('used_item_ids').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_replies_agent_created_idx').on(t.agentId, t.createdAt)],
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

/**
 * Where an agent's conversions go, and whether they go at all.
 *
 * One row per agent, keyed by the agent: this is the dataset tied to that agent's WhatsApp
 * number, and there is exactly one. pleep also keeps a second dataset for a website pixel;
 * this product has no website channel, and a settings form for a thing nobody can send to
 * is worse than not having it.
 */
export const capiSettings = pgTable('capi_settings', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  datasetId: text('dataset_id').notNull(),
  // Encrypted with the credentials key and sealed to the agent's id, like every other
  // secret here. Never selected into an API response.
  accessToken: text('access_token').notNull(),
  // Meta's test event code. Set while an owner is checking the wiring in Events Manager,
  // cleared afterwards — an event carrying it is not counted for optimisation.
  testEventCode: text('test_event_code'),
  enabled: boolean('enabled').notNull().default(false),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One thing worth telling Meta, and what happened when we told it.
 *
 * `eventId` is unique, and it is derived from what is being reported rather than from when:
 * the same order queued twice by a retry, a redelivery or an owner pressing resend is one
 * row, and Meta counts it once. The payload is stored as built, so a failure can be read
 * afterwards without rebuilding it from rows that may have changed since.
 */
export const capiEvents = pgTable(
  'capi_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Set null rather than cascade: a report that has already gone to Meta is a fact about
    // the past, and deleting the conversation does not unmake it.
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    // 'purchase' | 'lead'
    kind: text('kind').notNull(),
    eventId: text('event_id').notNull().unique(),
    // Text, not jsonb, and typed so only `serialiseEvent` can produce a value for it.
    //
    // The order's amount is exact only as long as nothing parses and re-emits it, and jsonb
    // parses: Postgres would store the number faithfully, but reading the column back hands
    // JavaScript a double, and re-serialising that double is no longer guaranteed to be the
    // digits the column held. Storing the finished request body means what is stored is byte
    // for byte what is sent — a resend writes the same bytes out again and nothing is ever
    // re-serialised, so no double appears anywhere on the path.
    //
    // The cost is that nothing can query inside the payload. Nothing needs to: the log screen
    // reads `kind`, `status`, `error` and `sentAt`, which are columns, and the body is only
    // ever read whole by a person looking at why one report failed.
    payload: text('payload').notNull().$type<CapiEventBody>(),
    // 'pending' | 'sent' | 'failed' | 'skipped'
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // When the last attempt was claimed, which is what the backoff measures from.
    //
    // From the attempt and not from `created_at`: a resend by hand resets `attempts` on a
    // row that may be days old, and a gap measured from creation would already have elapsed
    // — the five attempts would then be spent in seconds. Written by the claiming statement
    // itself, together with the increment, so the two can never disagree.
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    // What Meta answered when it refused. Redacted of the token before it is written.
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // Meta's own reference for the accepted send. It is the first thing their support asks
    // for when a report is missing from Events Manager, and by then the response is gone.
    // One id per send, so every event of a batch carries the same one.
    fbtraceId: text('fbtrace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('capi_events_status_created_idx').on(t.status, t.createdAt)],
);
