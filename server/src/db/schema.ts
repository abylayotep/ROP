import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tenancy plus authentication. Conversations, orders, knowledge and Meta credentials
 * arrive in their own plans, each with its own migration, and each keyed by agent_id.
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
