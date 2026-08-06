import { boolean, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Only the tables the foundation needs. Advertising, WhatsApp, analysis and money
 * tables arrive in their own plans, each with its own migration.
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Always stored lowercased. Plain text rather than citext, which would mean
  // installing an extension for a single column.
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  initials: text('initials').notNull(),
  role: text('role').notNull().default('owner'),
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

/** Single row, pinned by a boolean primary key that defaults to true. */
export const settings = pgTable('settings', {
  id: boolean('id').primaryKey().default(true),
  projectName: text('project_name').notNull(),
  planLine: text('plan_line').notNull(),
  currency: text('currency').notNull(),
  usdRate: numeric('usd_rate', { precision: 12, scale: 4 }).notNull(),
  timezone: text('timezone').notNull(),
  selectedAccountIds: text('selected_account_ids').array().notNull().default([]),
  syncMode: text('sync_mode').notNull(),
  metaBusinessId: text('meta_business_id'),
  metaPixelId: text('meta_pixel_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
