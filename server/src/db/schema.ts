import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const linkedHistoryPackets = pgTable('linked_history_packets', {
  id: uuid('id').primaryKey().defaultRandom(),
  numberId: uuid('number_id').notNull().references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
  digest: text('digest').notNull(),
  notification: text('notification'),
  payload: text('payload'),
  status: text('status').notNull().default('queued'),
  counts: jsonb('counts'),
  attempts: integer('attempts').notNull().default(0),
  errorCode: text('error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, table => [unique('linked_history_packet_digest').on(table.numberId, table.digest)]);

export const linkedHistoryMappings = pgTable('linked_history_mappings', {
  numberId: uuid('number_id').notNull().references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
  lid: text('lid').notNull(),
  phone: text('phone').notNull(),
}, table => [primaryKey({ columns: [table.numberId, table.lid] })]);
// Type-only, so this stays a leaf module at runtime. `capi_events.payload` holds the exact
// bytes sent to Meta, and the brand is what stops anything but `serialiseEvent` filling it.
import type { CapiEventBody } from '../lib/capi/events.js';
// Type-only, so this stays a leaf module at runtime. `coach_messages.proposal` holds what the
// coach suggested, and the brand is what stops anything but a real proposal filling it.
import type { CoachProposal } from '../lib/ai/coach.js';
import type { CoachSourceSnapshot, CorrectionType } from '@rakurs/contract';
// Type-only, so this stays a leaf module at runtime. `kb_drafts.ops` and `kb_drafts.base` hold
// what a draft would write and what it was tested against, and the brand is what stops anything
// but the drafts module filling them.
import type { DraftBase, DraftOp } from '../lib/drafts/ops.js';
import type { AutopilotLogEntry, PendingFix } from '../lib/drafts/autopilot-types.js';
import type {
  GenerationBatchManifest,
  GenerationManifest,
  GenerationStoredCounts,
  GenerationStoredSource,
} from '../lib/knowledge/generation-types.js';
import type {
  AiSandboxCheckout,
  AiTurnField,
  CommunicationStyle,
  KbGenerationClassification,
  KbGenerationConfidence,
  KbGenerationProposalKind,
  KbGenerationProposalStatus,
  KbGenerationSelection,
  KbGenerationWarning,
} from '@rakurs/contract';

export type AgentResponseMode = 'off' | 'test' | 'live';

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
    responseMode: text('response_mode').$type<AgentResponseMode>().notNull().default('off'),
    crmAnalysisMode: text('crm_analysis_mode').$type<'follow_ai' | 'independent'>().notNull().default('follow_ai'),
    testContactId: uuid('test_contact_id').references((): AnyPgColumn => contacts.id, {
      onDelete: 'set null',
    }),
    // An OpenRouter model id, exactly as OpenRouter spells it.
    model: text('model').notNull().default('openai/gpt-4o-mini'),
    // numeric, not real: a temperature read back as a string cannot drift through a float,
    // and it is written into a request body as text anyway.
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.30'),
    // 'auto' answers in the language the customer wrote in. Anything else is a language name
    // the prompt carries verbatim.
    replyLanguage: text('reply_language').notNull().default('auto'),
    communicationStyle: text('communication_style').$type<CommunicationStyle>().notNull().default('warm'),
    // Encrypted with the credentials key, the same way a WhatsApp token is. Never selected
    // into an API response.
    openrouterKey: text('openrouter_key'),
    // The instant this agent began recording stage movement into `stage_transitions`.
    //
    // Everything before it is unrecorded and unrecoverable: the cabinet kept only the last
    // move a lead made, and nothing it kept can be turned into the moves that came before.
    // The statistics screen names this date so an owner reads the funnel as «since then»
    // rather than assuming it covers the whole history of their business. The migration that
    // adds the column stamps every agent that already exists; a new agent takes the default.
    stageHistorySince: timestamp('stage_history_since', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // What the agent would say, versioned. Every write that changes an answer — a note, an
    // import, a rule, an applied draft — bumps it, and a test run records the version it ran
    // at. That is what lets «было» be reused across runs and what makes a draft tested against
    // a store that has since moved refuse to apply.
    configVersion: integer('config_version').notNull().default(1),
    // Where the handoff alert goes: digits only, international form, null when nobody is
    // told. Deliberately outside `configVersion` — it never reaches the prompt, so changing
    // it changes no answer.
    operatorNotifyPhone: text('operator_notify_phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agents_account_id_idx').on(t.accountId),
    unique('agents_account_id_id_key').on(t.accountId, t.id),
    check('agents_response_mode_check', sql`${t.responseMode} in ('off', 'test', 'live')`),
    check('agents_crm_analysis_mode_check', sql`${t.crmAnalysisMode} in ('follow_ai', 'independent')`),
  ],
);

/** A browser-only conversation whose state never enters the production CRM. */
export const aiSandboxSessions = pgTable(
  'ai_sandbox_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    title: text('title').notNull().default(''),
    phone: text('phone'),
    revision: integer('revision').notNull().default(0),
    // Deliberately not foreign keys: proposed state remains inspectable if a production funnel
    // item is later removed, and no sandbox operation may mutate that production row.
    stageId: uuid('stage_id'),
    stageName: text('stage_name'),
    // The sales-script step the rehearsal stands on, kept the way `stageId` is: no foreign key.
    scriptStepId: uuid('script_step_id'),
    fields: jsonb('fields').$type<AiTurnField[]>().notNull().default([]),
    crmSummary: text('crm_summary'),
    crmProfile: jsonb('crm_profile').$type<Record<string, string>>().notNull().default({}),
    outcome: text('outcome'),
    handoff: text('handoff'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.agentId],
      foreignColumns: [agents.accountId, agents.id],
      name: 'ai_sandbox_sessions_account_agent_fk',
    }).onDelete('cascade'),
    unique('ai_sandbox_sessions_scope_id_key').on(t.accountId, t.agentId, t.id),
    index('ai_sandbox_sessions_agent_updated_idx').on(t.agentId, t.updatedAt),
    check('ai_sandbox_sessions_revision_check', sql`${t.revision} >= 0`),
  ],
);

/** One ordered user/assistant exchange and its validated, unapplied effects. */
export const aiSandboxTurns = pgTable(
  'ai_sandbox_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    revision: integer('revision').notNull(),
    userText: text('user_text').notNull(),
    reply: text('reply'),
    configVersion: integer('config_version').notNull(),
    model: text('model').notNull(),
    sourceIds: jsonb('source_ids').$type<string[]>().notNull().default([]),
    stageId: uuid('stage_id'),
    stageName: text('stage_name'),
    fields: jsonb('fields').$type<AiTurnField[]>().notNull().default([]),
    effectSource: text('effect_source').$type<'ai' | 'crm'>().notNull().default('ai'),
    checkout: jsonb('checkout').$type<AiSandboxCheckout | null>(),
    // Catalog photos the reply would have sent. Ids, not foreign keys, for the same reason
    // `sourceIds` is: a rehearsal stays readable after the owner deletes the photo.
    photoIds: jsonb('photo_ids').$type<string[]>().notNull().default([]),
    handoff: text('handoff'),
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.accountId, t.agentId, t.sessionId],
      foreignColumns: [
        aiSandboxSessions.accountId,
        aiSandboxSessions.agentId,
        aiSandboxSessions.id,
      ],
      name: 'ai_sandbox_turns_session_scope_fk',
    }).onDelete('cascade'),
    unique('ai_sandbox_turns_session_revision_key').on(t.sessionId, t.revision),
    unique('ai_sandbox_turns_scope_id_key').on(t.accountId, t.agentId, t.sessionId, t.id),
    index('ai_sandbox_turns_session_revision_idx').on(t.sessionId, t.revision),
    check('ai_sandbox_turns_revision_check', sql`${t.revision} > 0`),
  ],
);

/**
 * A WhatsApp number the cabinet answers on, whichever way it was connected.
 *
 * `phoneNumberId` is unique across the whole product, not per agent: it identifies the number
 * inside Meta, an incoming webhook carries only that, and two agents claiming one number would
 * make the routing ambiguous. It is null for a linked device, which Meta knows nothing about —
 * hence a partial unique index rather than a column constraint.
 *
 * The three Cloud API columns and the two linked ones are each required for their own kind and
 * absent for the other, which the migration states as two check constraints. One table rather
 * than two because `conversations.whatsapp_number_id` points here: a second table would fork
 * that chain and every query along it.
 */
export const whatsappNumbers = pgTable(
  'whatsapp_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Null for a linked device: the three columns below are Meta's, and a linked device
    // never reaches Meta. Required for the two Cloud API kinds, by check constraint.
    phoneNumberId: text('phone_number_id'),
    wabaId: text('waba_id'),
    displayPhone: text('display_phone').notNull(),
    // Encrypted with the credentials key. Never selected into an API response.
    accessToken: text('access_token'),
    enabled: boolean('enabled').notNull().default(true),
    // When the stored token stops working, as Meta stated it at issue, or as Meta proved
    // it by refusing a request. Null means no deadline is known — a pasted system-user
    // token may be permanent, and rows older than this column have nothing to report.
    // The Embedded Signup configuration in production is built from Meta's «60-day token»
    // template, so every token it issues fills this in and every one of them dies.
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    // Set when Meta confirms our application is subscribed to the WABA. Until then the
    // number is connected but silent, which is the failure this column makes visible.
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    // 'manual' — ids and a system-user token pasted by the owner (stage 2).
    // 'coexistence' — the phone's own number, onboarded through Embedded Signup; the token
    // came from Meta, registration was skipped, and the phone keeps working (stage 7).
    // 'linked' — the phone's own number through a linked device, no Meta at all (stage 8).
    connectionKind: text('connection_kind').notNull().default('manual'),
    // The customer's business portfolio id, as Embedded Signup reported it. Informational.
    businessId: text('business_id'),
    // Both one-shot `smb_app_data` requests were accepted. Null with `syncError` set means
    // at least one was refused; Meta allows each exactly once, so nothing retries them.
    syncRequestedAt: timestamp('sync_requested_at', { withTimezone: true }),
    syncError: text('sync_error'),
    // 0..100 from `history.metadata.progress`; only ever grows.
    historyProgress: integer('history_progress').notNull().default(0),
    // Meta reported error 2593109: the owner turned history sharing off on the phone.
    historyDeclinedAt: timestamp('history_declined_at', { withTimezone: true }),
    // `account_update` said the phone disconnected the API. Cleared on reconnect.
    offboardedAt: timestamp('offboarded_at', { withTimezone: true }),
    // Linked only: the number's own id inside WhatsApp, and how the pairing stands.
    // `linkedJid` is what routes an incoming socket event to this row, the way
    // `phoneNumberId` routes a webhook delivery. 'pairing' | 'open' | 'logged_out'.
    linkedJid: text('linked_jid'),
    linkedState: text('linked_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('whatsapp_numbers_agent_id_idx').on(t.agentId),
    // Partial, because a linked device has no such id and many rows may hold null. Postgres
    // already treats nulls as distinct in a total unique index; saying `where … is not null`
    // out loud is what stops a later reader from "fixing" the index back into a total one.
    uniqueIndex('whatsapp_numbers_phone_number_id_key')
      .on(t.phoneNumberId)
      .where(sql`${t.phoneNumberId} is not null`),
  ],
);

/** A Page-linked Instagram professional account used for Direct messaging. */
export const instagramAccounts = pgTable(
  'instagram_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    instagramUserId: text('instagram_user_id').notNull(),
    pageId: text('page_id').notNull(),
    username: text('username'),
    /** Encrypted Page access token, sealed with instagramUserId. */
    accessToken: text('access_token').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('instagram_accounts_instagram_user_id_key').on(t.instagramUserId),
    unique('instagram_accounts_id_agent_key').on(t.id, t.agentId),
    index('instagram_accounts_agent_id_idx').on(t.agentId),
  ],
);

/**
 * One entry of a linked device's Baileys session.
 *
 * A row per key rather than one blob per number: the key store is written on almost every
 * message, and rewriting a whole session each time would make a busy number the busiest
 * writer in the database. `value` is encrypted with the credentials key, the same way an
 * access token is — a session is the ability to send as the owner, and a database dump
 * holding it plainly would hand that over.
 */
export const linkedSessionKeys = pgTable(
  'linked_session_keys',
  {
    whatsappNumberId: uuid('whatsapp_number_id')
      .notNull()
      .references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
    // Baileys' own key type: 'creds', 'pre-key', 'session', 'sender-key', 'app-state-sync-key'…
    category: text('category').notNull(),
    // Identity inside the category. 'creds' stores a single row, under the id 'me'.
    keyId: text('key_id').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.whatsappNumberId, t.category, t.keyId] })],
);

/** A person who wrote to us. Digits only, the shape WhatsApp uses in `wa_id`. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phone: text('phone'),
    // WhatsApp's profile name. Absent until the person's first message carries it.
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('contacts_id_agent_key').on(t.id, t.agentId),
    uniqueIndex('contacts_agent_phone_key').on(t.agentId, t.phone),
  ],
);

/** Instagram-scoped identity attached to a provider-neutral CRM contact. */
export const instagramContacts = pgTable(
  'instagram_contacts',
  {
    contactId: uuid('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    instagramAccountId: uuid('instagram_account_id').notNull(),
    instagramUserId: text('instagram_user_id').notNull(),
    username: text('username'),
  },
  (t) => [
    unique('instagram_contacts_account_user_key').on(t.instagramAccountId, t.instagramUserId),
    foreignKey({ columns: [t.contactId, t.agentId], foreignColumns: [contacts.id, contacts.agentId], name: 'instagram_contacts_contact_agent_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.instagramAccountId, t.agentId], foreignColumns: [instagramAccounts.id, instagramAccounts.agentId], name: 'instagram_contacts_account_agent_fk' }).onDelete('cascade'),
  ],
);

/**
 * An append-only record of every owner change to an agent's WhatsApp response scope.
 *
 * Contact ids are deliberately snapshots rather than foreign keys: deleting a contact may
 * clear the live setting, but it must not rewrite what an earlier owner selected. The actor
 * id is retained for the same reason even if that user later leaves the account.
 */
export const agentResponseModeChanges = pgTable(
  'agent_response_mode_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').notNull(),
    oldResponseMode: text('old_response_mode').$type<AgentResponseMode>().notNull(),
    oldTestContactId: uuid('old_test_contact_id'),
    newResponseMode: text('new_response_mode').$type<AgentResponseMode>().notNull(),
    newTestContactId: uuid('new_test_contact_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_response_mode_changes_agent_created_idx').on(t.agentId, t.createdAt),
    check(
      'agent_response_mode_changes_old_mode_check',
      sql`${t.oldResponseMode} in ('off', 'test', 'live')`,
    ),
    check(
      'agent_response_mode_changes_new_mode_check',
      sql`${t.newResponseMode} in ('off', 'test', 'live')`,
    ),
  ],
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
      .references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
    instagramAccountId: uuid('instagram_account_id')
      .references(() => instagramAccounts.id, { onDelete: 'cascade' }),
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
    // Where this conversation stands in the owner's sales script (`sales_script_steps`). Set by
    // the reply turn after a reply reached the customer; `set null` when the owner deletes the
    // step, and the next reply picks a step again.
    scriptStepId: uuid('script_step_id').references((): AnyPgColumn => salesScriptSteps.id, {
      onDelete: 'set null',
    }),
    // When the current sale entered the script: set with the first step, and again whenever the
    // conversation goes back to the first step for a new purchase. A paid order counts toward a
    // «ждать оплату» step only when it is newer than this, so last month's order does not pay
    // for today's.
    scriptStartedAt: timestamp('script_started_at', { withTimezone: true }),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    // The agent answers on this thread. An operator who steps in turns it off here rather
    // than for the whole agent — the rest of the funnel keeps working.
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_number_contact_key').on(t.whatsappNumberId, t.contactId),
    uniqueIndex('conversations_instagram_contact_key').on(t.instagramAccountId, t.contactId)
      .where(sql`${t.instagramAccountId} is not null`),
    check('conversations_one_provider_check', sql`num_nonnulls(${t.whatsappNumberId}, ${t.instagramAccountId}) = 1`),
    foreignKey({ columns: [t.contactId, t.agentId], foreignColumns: [contacts.id, contacts.agentId], name: 'conversations_contact_agent_fk' }).onDelete('cascade'),
    foreignKey({ columns: [t.instagramAccountId, t.agentId], foreignColumns: [instagramAccounts.id, instagramAccounts.agentId], name: 'conversations_instagram_account_agent_fk' }).onDelete('cascade'),
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
    instagramMessageId: text('instagram_message_id').unique(),
    // 'in' | 'out'
    direction: text('direction').notNull(),
    // 'client' | 'operator' | 'ai' | 'system' | 'phone' — 'phone' is the operator answering
    // from the WhatsApp Business app; the cabinet only ever sees its echo.
    author: text('author').notNull(),
    // WhatsApp's own type: text, image, audio, video, document, sticker, location,
    // contacts, or unsupported for anything we do not render.
    kind: text('kind').notNull(),
    body: text('body'),
    mediaPath: text('media_path'),
    mediaMime: text('media_mime'),
    // How to fetch the file when `mediaPath` is null: the WhatsApp message itself, kept
    // exactly as the phone sent it. The history import writes rows for months of chats and
    // downloads nothing — bytes most threads are never scrolled back to — so the file is
    // fetched the first time someone opens it, and that fetch needs the message's own keys.
    // Null once the file is on disk, and for every message that never had one.
    mediaRef: jsonb('media_ref'),
    // Set on a catalog photo the agent sent, so the next turn knows not to send it again.
    // Set null when the photo is deleted: the message keeps its own copy of the file, and a
    // photo that no longer exists cannot be offered twice anyway.
    productPhotoId: uuid('product_photo_id').references((): AnyPgColumn => productPhotos.id, {
      onDelete: 'set null',
    }),
    // Outbound only: sent, delivered, read, failed.
    status: text('status'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt, t.id),
    index('messages_conversation_created_at_idx').on(t.conversationId, t.createdAt)],
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
    // 'active' | 'qualified' | 'success' | 'failure'
    kind: text('kind').notNull(),
    position: integer('position').notNull(),
    description: text('description').notNull().default(''),
    // What the agent should achieve while a conversation sits on this stage — the step of
    // the sale it is on. `description` says when a conversation belongs here (the CRM reads
    // it); this says what to do about it (the reply prompt reads it).
    agentGoal: text('agent_goal').notNull().default(''),
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
    // Set the first time a reply turn acted on this payment for the sales script — the turn the
    // payment itself starts, or a customer's turn that already saw it. The claim is the whole
    // defence against sending the after-payment step twice, so it is written before the send.
    scriptPaymentTurnAt: timestamp('script_payment_turn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_conversation_idx').on(t.conversationId),
    index('orders_agent_paid_at_idx').on(t.agentId, t.paidAt),
  ],
);

/**
 * One move of one lead from one stage to another.
 *
 * Append-only. Nothing updates or deletes a row here: a move recorded wrongly is corrected
 * by the next move, not by rewriting this one. That is what lets the funnel be read as a
 * ledger — the count of entries into a stage over a period cannot change after the fact.
 *
 * Every stage is stored twice, as an id and as a snapshot of its name, kind and position at
 * the moment of the move. An owner may delete a stage once it is empty, and `set null` on
 * the id alone would erase which stage a lead passed through, leaving a row that says a move
 * happened but not where to. The snapshot keeps the row readable forever; the id is what the
 * funnel joins on while the stage still exists, and what the chain is built from.
 *
 * `conversationId` cascades, unlike `capi_events.conversation_id`, which nulls. The funnel
 * counts distinct conversations per stage, and a row whose conversation is gone cannot be
 * counted distinctly without inventing an identity for it. A report already sent to Meta is
 * a fact about the outside world and survives the lead; a row here is only ever an input to
 * our own arithmetic, so it goes when the lead does.
 */
export const stageTransitions = pgTable(
  'stage_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fromStageId: uuid('from_stage_id').references(() => stages.id, { onDelete: 'set null' }),
    toStageId: uuid('to_stage_id').references(() => stages.id, { onDelete: 'set null' }),
    // Null exactly when the lead came from nowhere — its first stage.
    fromName: text('from_name'),
    toName: text('to_name').notNull(),
    // 'active' | 'qualified' | 'success' | 'failure'; rows before migration 0050 may say 'awaiting_payment'
    toKind: text('to_kind').notNull(),
    fromPosition: integer('from_position'),
    toPosition: integer('to_position').notNull(),
    // 'operator' | 'ai' | 'scenario' | 'system'
    movedBy: text('moved_by').notNull(),
    movedByUserId: uuid('moved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stage_transitions_agent_occurred_idx').on(t.agentId, t.occurredAt),
    index('stage_transitions_conversation_idx').on(t.conversationId, t.occurredAt),
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
 * It exists so that a reimport can replace what it made. A note written by hand has no
 * source, which is why `kb_notes.source_id` is nullable.
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
 * One note: what a person writes and reads. `path` is its identity — «Товары/Двери входные» —
 * and folders are the segments before the last slash rather than a table, exactly as a folder
 * in a vault exists because a file is in it.
 */
export const kbNotes = pgTable(
  'kb_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // Set null, not cascade: deleting an import must not delete the notes it produced.
    sourceId: uuid('source_id').references(() => kbSources.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    // The last path segment, stored so search can weight it without parsing the path.
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    // 'product' | 'qa' | 'procedure' | 'contact' | 'other', read out of the frontmatter.
    kind: text('kind').notNull().default('other'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    // True once a person has changed it. A reimport replaces what it made, except these.
    edited: boolean('edited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('kb_notes_agent_path_key').on(t.agentId, t.path),
          index('kb_notes_agent_updated_idx').on(t.agentId, t.updatedAt)],
);

/**
 * One section of a note: the unit search ranks and the agent quotes.
 *
 * Derived and disposable. Every save deletes a note's rows here and writes them again, so
 * nothing but `saveNote` may insert one and nothing may read a note's text out of one.
 */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id').notNull().references(() => kbNotes.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading').notNull().default(''),
    // «Заметка › Раздел», or the note title for the lead section. Stored, not composed at
    // read time: it is what the tsvector weights, and a composed value cannot be indexed.
    title: text('title').notNull(),
    content: text('content').notNull(),
    kind: text('kind').notNull().default('other'),
    search: tsvector('search').notNull().generatedAlwaysAs(
      sql`setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_chunks_agent_kind_idx').on(t.agentId, t.kind),
          index('kb_chunks_search_idx').using('gin', t.search),
          index('kb_chunks_note_ordinal_idx').on(t.noteId, t.ordinal)],
);

/**
 * One `[[link]]`. `toNoteId` is null while the target does not exist: a link written before
 * its note is a broken link the vault shows as one, not a reason to refuse the text.
 */
export const kbLinks = pgTable(
  'kb_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    fromNoteId: uuid('from_note_id').notNull().references(() => kbNotes.id, { onDelete: 'cascade' }),
    toNoteId: uuid('to_note_id').references(() => kbNotes.id, { onDelete: 'set null' }),
    target: text('target').notNull(),
  },
  (t) => [index('kb_links_agent_target_idx').on(t.agentId, t.toNoteId),
          index('kb_links_from_idx').on(t.fromNoteId)],
);

/**
 * One thing the business sells, as the agent quotes it.
 *
 * Separate from the knowledge base on purpose: a price is structured data an owner edits in
 * a table, not a sentence retrieval may or may not surface. The whole active catalog travels
 * with every turn, so the agent never answers «уточню» about something the shop lists.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    // Off hides the product from the agent without losing its prices and photos.
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('products_agent_position_idx').on(t.agentId, t.position)],
);

/**
 * One price of a product: a size, a thickness, a colour. A product sold at a single price has
 * one variant with an empty label. A row with its own id, not a jsonb list, so a later
 * promotion can point at «this product, 40 мм» and survive the owner renaming the label.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    // Whole units of the agent's currency — tenge have no minor unit anyone quotes.
    price: integer('price').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('product_variants_product_position_idx').on(t.productId, t.position),
    check('product_variants_price_check', sql`${t.price} >= 0`),
  ],
);

/**
 * One product photo, stored under `MEDIA_DIR` exactly like a message's file: `mediaPath` is
 * relative to it and is the only path ever read.
 */
export const productPhotos = pgTable(
  'product_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    mediaPath: text('media_path').notNull(),
    mediaMime: text('media_mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    filename: text('filename').notNull().default(''),
    // Read by the agent to pick the right photo; never sent to the customer.
    caption: text('caption'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('product_photos_product_position_idx').on(t.productId, t.position)],
);

/**
 * A promotion preset («акция»): promotional prices for some catalog variants, prepared ahead
 * and switched on with a click.
 *
 * In effect while `active` and before `ends_at` (never, when null). Nothing flips the row when
 * the date passes; every reader evaluates it, and `settleExpiredPromotions` turns an expired
 * active row off — bumping `config_version` — the first time a request or a turn sees it.
 * At most one active row per agent: the partial unique index is the guarantee, the activate
 * route's own «switch the others off» is only what keeps it from ever firing.
 */
export const promotions = pgTable(
  'promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Extra conditions the agent may mention, «упаковка в подарок». Data, never a rule.
    description: text('description').notNull().default(''),
    active: boolean('active').notNull().default(false),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('promotions_agent_position_idx').on(t.agentId, t.position),
    uniqueIndex('promotions_one_active_per_agent').on(t.agentId).where(sql`${t.active}`),
  ],
);

/**
 * One variant's price while its promotion is in effect. The final price, not a discount: the
 * owner thinks «6990», and the agent quotes exactly what the owner typed. Removing the variant
 * from the catalog removes it from every promotion.
 */
export const promotionItems = pgTable(
  'promotion_items',
  {
    promotionId: uuid('promotion_id').notNull().references(() => promotions.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').notNull().references(() => productVariants.id, { onDelete: 'cascade' }),
    promoPrice: integer('promo_price').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.promotionId, t.variantId] }),
    index('promotion_items_variant_idx').on(t.variantId),
    check('promotion_items_promo_price_check', sql`${t.promoPrice} >= 0`),
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
    // The knowledge chunks — sections of a note, since the vault replaced flat records — the
    // reply was built from, so a wrong answer leads to the section that produced it.
    // The column keeps the name `used_item_ids` rather than being renamed to match: it reads
    // fine either way ("the knowledge items a reply used"), and a rename would buy nothing
    // behavioural while touching every reader of this table, statistics included.
    // Typed at the column rather than cast at every read: the only thing that ever goes in
    // here is a list of chunk ids, and an `unknown` would make each caller assert that
    // separately.
    usedItemIds: jsonb('used_item_ids').$type<string[]>().notNull().default([]),
    configVersion: integer('config_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_replies_agent_created_idx').on(t.agentId, t.createdAt),
    unique('ai_replies_agent_conversation_id_key').on(t.agentId, t.conversationId, t.id),
    index('ai_replies_message_idx').on(t.messageId)],
);

/** Immutable evidence captured when an owner corrects a particular AI response. */
export const responseFeedback = pgTable('response_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  conversationId: uuid('conversation_id'),
  aiReplyId: uuid('ai_reply_id'),
  sessionId: uuid('session_id'),
  sandboxTurnId: uuid('sandbox_turn_id'),
  correctionType: text('correction_type').$type<CorrectionType>().notNull(),
  note: text('note').notNull(),
  requestKey: uuid('request_key'),
  requestedByUserId: uuid('requested_by_user_id'),
  requestHash: text('request_hash'),
  failureReason: text('failure_reason'),
  snapshot: jsonb('snapshot').$type<CoachSourceSnapshot>().notNull(),
  revision: integer('revision').notNull().default(1),
  status: text('status').$type<'pending' | 'proposed' | 'drafted' | 'failed'>().notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ columns: [t.accountId, t.agentId], foreignColumns: [agents.accountId, agents.id], name: 'response_feedback_agent_scope_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.agentId, t.conversationId, t.aiReplyId], foreignColumns: [aiReplies.agentId, aiReplies.conversationId, aiReplies.id], name: 'response_feedback_live_scope_fk' }),
  foreignKey({ columns: [t.accountId, t.agentId, t.sessionId, t.sandboxTurnId], foreignColumns: [aiSandboxTurns.accountId, aiSandboxTurns.agentId, aiSandboxTurns.sessionId, aiSandboxTurns.id], name: 'response_feedback_sandbox_scope_fk' }),
  check('response_feedback_one_source_check', sql`(${t.conversationId} is not null and ${t.aiReplyId} is not null and ${t.sessionId} is null and ${t.sandboxTurnId} is null) or (${t.conversationId} is null and ${t.aiReplyId} is null and ${t.sessionId} is not null and ${t.sandboxTurnId} is not null)`),
  check('response_feedback_type_check', sql`${t.correctionType} in ('fact', 'behavior')`),
  check('response_feedback_revision_check', sql`${t.revision} > 0`),
  check('response_feedback_snapshot_bounds_check', sql`jsonb_typeof(${t.snapshot}) = 'object' and (${t.snapshot} - 'transcript' - 'responseText' - 'configVersion' - 'sourceIds' - 'sourceRecords') = '{}'::jsonb and jsonb_typeof(${t.snapshot}->'transcript') = 'string' and length(${t.snapshot}->>'transcript') <= 12000 and jsonb_typeof(${t.snapshot}->'responseText') = 'string' and length(${t.snapshot}->>'responseText') <= 4000 and jsonb_typeof(${t.snapshot}->'configVersion') in ('number', 'null') and jsonb_typeof(${t.snapshot}->'sourceIds') = 'array' and jsonb_array_length(${t.snapshot}->'sourceIds') <= 30 and jsonb_typeof(${t.snapshot}->'sourceRecords') = 'array' and jsonb_array_length(${t.snapshot}->'sourceRecords') <= 30 and pg_column_size(${t.snapshot}) <= 32768`),
  index('response_feedback_agent_created_idx').on(t.agentId, t.createdAt),
  unique('response_feedback_request_key').on(t.agentId, t.requestedByUserId, t.requestKey),
]);

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

/** Signed Instagram webhook deliveries, retained until their normalized work succeeds. */
export const instagramEvents = pgTable(
  'instagram_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    processingAt: timestamp('processing_at', { withTimezone: true }),
    conversationIds: jsonb('conversation_ids').$type<string[]>(),
  },
  (t) => [index('instagram_events_processed_at_idx').on(t.processedAt)],
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

/**
 * One step of the owner's sales script: the order a sale is talked through.
 *
 * Separate from the funnel on purpose. A stage is a CRM column and a script has as many steps
 * as the owner needs; a step may name a stage the lead moves to when the step starts, but does
 * not have to. A step with `parentId` is a branch under a main-chain step («если клиент
 * сомневается»), and a branch has no branches of its own — the API keeps the depth at two.
 *
 * `photoIds` and `fieldIds` are lists of ids rather than join tables because they are only
 * ever read whole, with the step, and the API checks each id against the agent's own catalog
 * and fields on every save. An id whose photo or field is later deleted is dropped where it is
 * read, never sent.
 */
export const salesScriptSteps = pgTable(
  'sales_script_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => salesScriptSteps.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    condition: text('condition').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    stageId: uuid('stage_id').references(() => stages.id, { onDelete: 'set null' }),
    photoIds: jsonb('photo_ids').$type<string[]>().notNull().default([]),
    fieldIds: jsonb('field_ids').$type<string[]>().notNull().default([]),
    handoff: boolean('handoff').notNull().default(false),
    handoffNote: text('handoff_note').notNull().default(''),
    waitPayment: boolean('wait_payment').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sales_script_steps_agent_parent_position_idx').on(t.agentId, t.parentId, t.position)],
);

/**
 * One rule the agent follows: how to speak, what to ask, what never to do, what we are.
 *
 * A row rather than a paragraph in a text field, because a rule has to be switchable and
 * orderable on its own — an owner testing whether a sentence caused a bad answer turns that
 * sentence off, and a wall of text has no off switch.
 */
export const agentRules = pgTable(
  'agent_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // 'business' | 'tone' | 'order' | 'forbid'. Four, because the prompt groups by them and a
    // free-form label would drift into forty groups nobody reads.
    category: text('category').notNull(),
    text: text('text').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // 'manual' | 'coach' — what the owner wrote against what they approved.
    origin: text('origin').notNull().default('manual'),
    // Order inside a category. The prompt follows it, so a reordered list reorders the rules
    // the model reads.
    position: integer('position').notNull().default(0),
    // Meant to be set when the owner insists on a rule the fact check wanted to be a note —
    // shown beside the rule, because a number in instructions is a number no record backs.
    // No writer exists yet: `POST /rules` (api/rules.ts) does not accept this field, and the
    // spec's «Всё равно правилом» escape hatch was never built (the fact check discards a
    // rule's category the moment it rewrites the proposal into a note, so there is nothing
    // for that button to keep). A later plan that actually builds the escape hatch is what
    // gives this column its writer; the column stays so that plan does not also need a
    // migration.
    warning: text('warning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_rules_agent_category_idx').on(t.agentId, t.category, t.position)],
);

/**
 * One turn of the coaching conversation.
 *
 * `proposal` is what the model suggests and nothing more: this table is the only thing the
 * coach routes write, and a proposal reaches the store only through a draft.
 */
export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // 'owner' | 'model'
    role: text('role').notNull(),
    text: text('text').notNull(),
    // A `CoachProposal`, or null on the owner's own lines and on a plain reply.
    proposal: jsonb('proposal').$type<CoachProposal>(),
    // Why the fact check rewrote a rule proposal into a note, when it did. Null on the
    // owner's own lines, on a plain reply, and on a proposal the check left alone. Stored
    // rather than returned only on the POST response: a reload of the coaching chat has to
    // show the same explanation the owner saw the moment the card appeared, not lose it the
    // instant they leave the screen.
    warning: text('warning'),
    // 'pending' | 'drafted' | 'rejected'
    status: text('status').notNull().default('pending'),
    // The dialog this coaching started from, and the turn inside it, so the model reads what
    // the agent actually answered rather than what the owner remembers of it.
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    aiReplyId: uuid('ai_reply_id').references(() => aiReplies.id, { onDelete: 'set null' }),
    feedbackId: uuid('feedback_id').references((): AnyPgColumn => responseFeedback.id, { onDelete: 'set null' }),
    revision: integer('revision').notNull().default(1),
    sourceSnapshot: jsonb('source_snapshot').$type<CoachSourceSnapshot>(),
    // The draft this message's proposal became, once one was opened. Null on the owner's own
    // lines, on a plain reply, and before the proposal has been drafted.
    draftId: uuid('draft_id').references((): AnyPgColumn => kbDrafts.id, { onDelete: 'set null' }),
    // The instant the store (`allRules`/`notePathsFor`) was read to build this reply's own
    // prompt — set only on a `role: 'model'` row, right after the owner's line that started
    // this turn is written, and always null on that owner line itself. `createdAt` below is
    // stamped when *this* row is inserted, which is after the model has answered — up to two
    // attempts, each up to a model timeout, apart from the read. `POST …/coach/messages/:id/draft`
    // compares an edited row's `updatedAt` against this column, not `createdAt`, so an owner who
    // edits the very row the coach is still thinking about is refused — comparing against
    // `createdAt` would miss exactly that edit, since it lands before `createdAt` is stamped but
    // after the context this proposal was actually written against was read.
    contextAt: timestamp('context_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('coach_messages_agent_created_idx').on(t.agentId, t.createdAt)],
);

/**
 * One change, waiting to be proven.
 *
 * `ops` is what would be written; `base` is the `updatedAt` of everything the ops touch, taken
 * when the draft was made. Applying compares the two, because a draft is a promise that what
 * was tested is what lands, and a note edited underneath it makes that promise false.
 */
export const kbDrafts = pgTable(
  'kb_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // 'coach' | 'manual'
    origin: text('origin').notNull(),
    // 'open' | 'applied' | 'discarded'
    status: text('status').notNull().default('open'),
    ops: jsonb('ops').$type<DraftOp[]>().notNull(),
    base: jsonb('base').$type<DraftBase>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('kb_drafts_agent_status_idx').on(t.agentId, t.status, t.createdAt)],
);

/** A no-cost, short-lived snapshot of the exact messages an owner selected. */
export const kbGenerationPreviews = pgTable(
  'kb_generation_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    selection: jsonb('selection').$type<KbGenerationSelection>().notNull(),
    manifest: jsonb('manifest').$type<GenerationManifest>().notNull(),
    counts: jsonb('counts').$type<GenerationStoredCounts>().notNull(),
    modelId: text('model_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('kb_generation_previews_agent_expires_idx').on(t.agentId, t.expiresAt)],
);

/** One durable extraction request, including its immutable source manifest but no chat text. */
export const kbGenerationRuns = pgTable(
  'kb_generation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Immutable request identity. Deliberately no FK: expired-preview cleanup must not erase
    // which preview an idempotency key originally started from.
    requestedPreviewId: uuid('requested_preview_id').notNull(),
    requestKey: text('request_key').notNull(),
    selection: jsonb('selection').$type<KbGenerationSelection>().notNull(),
    manifest: jsonb('manifest').$type<GenerationManifest>().notNull(),
    counts: jsonb('counts').$type<GenerationStoredCounts>().notNull(),
    modelId: text('model_id').notNull(),
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull(),
    // 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    status: text('status').notNull().default('queued'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kb_generation_runs_agent_request_key').on(t.agentId, t.requestKey),
    uniqueIndex('kb_generation_runs_one_active_per_agent')
      .on(t.agentId)
      .where(sql`${t.status} in ('queued', 'running')`),
    index('kb_generation_runs_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);

/** One sequential provider call inside a run. */
export const kbGenerationBatches = pgTable(
  'kb_generation_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => kbGenerationRuns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    manifest: jsonb('manifest').$type<GenerationBatchManifest>().notNull(),
    classification: text('classification').$type<KbGenerationClassification>(),
    classificationReason: text('classification_reason'),
    // 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('kb_generation_batches_run_ordinal').on(t.runId, t.ordinal)],
);

/** Immutable grounded findings retained for audit and consolidation recovery. */
export const kbGenerationRawFindings = pgTable(
  'kb_generation_raw_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => kbGenerationRuns.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull().references(() => kbGenerationBatches.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    legacyKind: text('legacy_kind').$type<KbGenerationProposalKind>(),
    legacyRevision: integer('legacy_revision'),
    legacyStatus: text('legacy_status').$type<KbGenerationProposalStatus>(),
    legacyDraftId: uuid('legacy_draft_id'),
    legacyDraftOpIndex: integer('legacy_draft_op_index'),
    legacyNoteId: uuid('legacy_note_id'),
    path: text('path').notNull(),
    body: text('body').notNull(),
    warnings: text('warnings').array().$type<KbGenerationWarning[]>().notNull().default(sql`'{}'::text[]`),
    sources: jsonb('sources').$type<GenerationStoredSource[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_generation_raw_findings_run_created_idx').on(t.runId, t.createdAt),
    index('kb_generation_raw_findings_run_fingerprint_idx').on(t.runId, t.fingerprint),
  ],
);

/** A source-backed suggestion waiting for explicit review and draft conversion. */
export const kbGenerationProposals = pgTable(
  'kb_generation_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => kbGenerationRuns.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull().references(() => kbGenerationBatches.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    revision: integer('revision').notNull().default(1),
    kind: text('kind').$type<KbGenerationProposalKind>().notNull().default('knowledge'),
    path: text('path').notNull(),
    body: text('body').notNull(),
    confidence: text('confidence').$type<KbGenerationConfidence>().notNull().default('review'),
    selected: boolean('selected').notNull().default(false),
    warnings: text('warnings').array().$type<KbGenerationWarning[]>().notNull().default(sql`'{}'::text[]`),
    sources: jsonb('sources').$type<GenerationStoredSource[]>().notNull(),
    // 'pending' | 'rejected' | 'drafted' | 'applied'
    status: text('status').notNull().default('pending'),
    draftId: uuid('draft_id').references(() => kbDrafts.id, { onDelete: 'set null' }),
    draftOpIndex: integer('draft_op_index'),
    noteId: uuid('note_id').references(() => kbNotes.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kb_generation_proposals_run_fingerprint').on(t.runId, t.fingerprint),
    index('kb_generation_proposals_run_status_idx').on(t.runId, t.status, t.createdAt),
    index('kb_generation_proposals_draft_idx').on(t.draftId),
    index('kb_generation_proposals_note_idx').on(t.noteId),
  ],
);

/** Every draft assembled from one generation run; a run may produce more than one draft. */
export const kbGenerationDrafts = pgTable(
  'kb_generation_drafts',
  {
    runId: uuid('run_id').notNull().references(() => kbGenerationRuns.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').notNull().references(() => kbDrafts.id, { onDelete: 'cascade' }),
    requestKey: text('request_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('kb_generation_drafts_run_draft').on(t.runId, t.draftId),
    index('kb_generation_drafts_draft_idx').on(t.draftId),
  ],
);

/**
 * One conversation to replay. `messages` is the customer's side only — the agent's replies are
 * what is being tested, and storing them here would be storing the answer in the question.
 */
export const testCases = pgTable(
  'test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    messages: jsonb('messages').$type<string[]>().notNull(),
    // What the owner expects, in words. Read by a person and by the annotating model, never
    // asserted on: turning it into an assertion is a feature with its own grammar.
    expectation: text('expectation'),
    // 'manual' | 'dialog' | 'generated' | 'correction' | 'suggested' (saved by the draft autopilot)
    origin: text('origin').notNull().default('manual'),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    requiredDraftId: uuid('required_draft_id').references((): AnyPgColumn => kbDrafts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('test_cases_agent_enabled_idx').on(t.agentId, t.enabled),
    unique('test_cases_required_draft_key').on(t.requiredDraftId)],
);

/** One pass over a set of cases. `draftId` null is a baseline: the store as it stands. */
export const testRuns = pgTable(
  'test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').references(() => kbDrafts.id, { onDelete: 'cascade' }),
    // The agent's version at the moment the run started. A baseline is reusable only at the
    // same version and the same model.
    configVersion: integer('config_version').notNull(),
    model: text('model').notNull(),
    // 'running' | 'done' | 'failed'
    status: text('status').notNull().default('running'),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('test_runs_agent_draft_idx').on(t.agentId, t.draftId, t.startedAt),
          index('test_runs_baseline_idx').on(t.agentId, t.configVersion)],
);

/** What one case produced in one run, and what the annotating model thought of it. */
export const testResults = pgTable(
  'test_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
    reply: text('reply'),
    usedChunkIds: jsonb('used_chunk_ids').$type<string[]>().notNull().default([]),
    // Indexes into the draft's ops at the time of the run; baseline rows keep '{}'.
    usedOpIndexes: integer('used_op_indexes').array().notNull().default(sql`'{}'`),
    // A run records the stage a rolled-back turn *would* have moved to, and a foreign key would
    // point from surviving data at a row somebody may later delete — so this is a plain uuid,
    // not a reference.
    stageId: uuid('stage_id'),
    handoff: boolean('handoff').notNull().default(false),
    handoffReason: text('handoff_reason'),
    // The `TurnOutcome` the replay ended in.
    outcome: text('outcome').notNull(),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    // 'better' | 'worse' | 'same', or null when the annotation did not run or failed. A hint
    // in a column: it gates nothing.
    verdict: text('verdict'),
    verdictReason: text('verdict_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('test_results_run_case_key').on(t.runId, t.caseId)],
);

/**
 * One autopilot pass over a draft. The row is the whole state, so a restart resumes at `step`.
 * `run_ops` pins the ops a run started with: op indexes in its results mean nothing against a
 * later version of the draft.
 */
export const draftAutopilots = pgTable(
  'draft_autopilots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').notNull().references(() => kbDrafts.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    // 'running' | 'applied' | 'stopped' | 'cancelled'
    status: text('status').notNull(),
    // 'prepare_cases' | 'clean_topics' | 'start_run' | 'await_run' | 'fix_topics' | 'apply'
    step: text('step').notNull(),
    caseIds: uuid('case_ids').array().notNull().default(sql`'{}'`),
    runId: uuid('run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    runOps: jsonb('run_ops').$type<DraftOp[] | null>(),
    runsStarted: integer('runs_started').notNull().default(0),
    runFailures: integer('run_failures').notNull().default(0),
    noiseRetryUsed: boolean('noise_retry_used').notNull().default(false),
    topicAttempts: jsonb('topic_attempts').$type<Record<string, number>>().notNull().default({}),
    pendingFixes: jsonb('pending_fixes').$type<PendingFix[] | null>(),
    log: jsonb('log').$type<AutopilotLogEntry[]>().notNull().default([]),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    stopReason: text('stop_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('draft_autopilots_one_running').on(t.draftId).where(sql`${t.status} = 'running'`),
    index('draft_autopilots_running').on(t.status).where(sql`${t.status} = 'running'`),
  ],
);

/** Encrypted cashier credentials and an agent-bound, short-lived SMS challenge. */
export const kaspiSessions = pgTable('kaspi_sessions', {
  agentId: uuid('agent_id').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
  credentials: text('credentials'),
  organization: text('organization'),
  merchantId: text('merchant_id'),
  phone: text('phone'),
  processId: text('process_id'),
  processExpiresAt: timestamp('process_expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A create intent is committed before calling Kaspi; ambiguous requests never auto-retry. */
export const kaspiPayments = pgTable('kaspi_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull().unique().references(() => orders.id, { onDelete: 'restrict' }),
  requestKey: text('request_key').notNull(),
  method: text('method').notNull(),
  phone: text('phone').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  operationId: text('operation_id'),
  qrToken: text('qr_token'),
  paymentUrl: text('payment_url'),
  status: text('status').notNull().default('creating'),
  error: text('error'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  // Claimed as unknown before any external send; an uncertain delivery never auto-retries.
  notificationStatus: text('notification_status').notNull().default('pending'),
  notificationMessageId: text('notification_message_id'),
  notificationClaimedAt: timestamp('notification_claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('kaspi_payments_agent_request_key').on(t.agentId, t.requestKey),
  unique('kaspi_payments_agent_operation_key').on(t.agentId, t.operationId),
  uniqueIndex('kaspi_payments_one_open_conversation').on(t.conversationId).where(sql`${t.status} in ('creating', 'unknown', 'pending')`),
  index('kaspi_payments_status_checked_idx').on(t.status, t.checkedAt),
]);

/** Incremental CRM analysis; a lease prevents duplicate model work across workers. */
export const crmAnalyses = pgTable('crm_analyses', {
  conversationId: uuid('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  sourceVersion: timestamp('source_version', { withTimezone: true }),
  analyzedMessageId: uuid('analyzed_message_id'),
  pendingLiveMessageId: uuid('pending_live_message_id'),
  handledLiveMessageId: uuid('handled_live_message_id'),
  fieldEvidence: jsonb('field_evidence').$type<Record<string, { messageId: string; sentAt: string; value?: string }>>().notNull().default({}),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  summary: text('summary'),
  profile: jsonb('profile').$type<Record<string, string>>().notNull().default({}),
  confidence: integer('confidence'),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
