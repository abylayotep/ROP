import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { isTokenRejection, markTokenRejected } from '../src/lib/whatsapp/token-expiry.js';
import { withDb } from './helpers/db.js';

/**
 * The correction Meta makes to our own bookkeeping.
 *
 * `token_expires_at` is written once, from what Meta said at issue, and that date is a
 * prediction. A token also dies early — access revoked, application removed — and the row
 * would go on claiming a month of life while every message failed.
 */

const DAY = 24 * 60 * 60 * 1000;

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Сафина' }).returning();
  agentId = agent!.id;
});

const seedNumber = async (tokenExpiresAt: Date | null) =>
  (
    await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        phoneNumberId: '136',
        wabaId: '932',
        displayPhone: '+7 708 580 79 32',
        accessToken: 'encrypted',
        connectionKind: 'coexistence',
        tokenExpiresAt,
      })
      .returning()
  )[0]!;

const reread = async (id: string) =>
  (await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, id)))[0]!;

describe('isTokenRejection', () => {
  it('recognises the one code that means the token itself is no good', () => {
    expect(isTokenRejection(new GraphError('Session has expired', 401, 190))).toBe(true);
  });

  it('does not treat a missing permission as an expired token', () => {
    // Code 200 is «this token may not do that». Re-connecting issues the same token with
    // the same permissions, so sending the owner round that loop changes nothing.
    expect(isTokenRejection(new GraphError('Permissions error', 403, 200))).toBe(false);
    expect(isTokenRejection(new GraphError('Rate limit', 429))).toBe(false);
    expect(isTokenRejection(new Error('websocket exploded'))).toBe(false);
  });
});

describe('markTokenRejected', () => {
  it('brings a deadline still a month away forward to now', async () => {
    const number = await seedNumber(new Date(Date.now() + 30 * DAY));

    await markTokenRejected(db, number.id);

    const after = await reread(number.id);
    expect(after.tokenExpiresAt!.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('gives a deadline to a number that never had one', async () => {
    // A manual number with a pasted token: nothing was ever known about its lifetime, and
    // Meta has just answered the question.
    const number = await seedNumber(null);

    await markTokenRejected(db, number.id);

    expect((await reread(number.id)).tokenExpiresAt).not.toBeNull();
  });

  it('keeps the moment a number first went dead', async () => {
    // Otherwise every attempted send would reset the clock, and a number that has been
    // broken for a week would read as «expired just now» forever.
    const week = new Date(Date.now() - 7 * DAY);
    const number = await seedNumber(week);

    await markTokenRejected(db, number.id);

    expect((await reread(number.id)).tokenExpiresAt).toEqual(week);
  });

  it('touches nothing but the number it was given', async () => {
    const one = await seedNumber(new Date(Date.now() + 30 * DAY));
    const other = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        phoneNumberId: '137',
        wabaId: '932',
        displayPhone: '+7 708 580 79 33',
        accessToken: 'encrypted',
        connectionKind: 'coexistence',
        tokenExpiresAt: new Date('2027-01-09T09:00:00.000Z'),
      })
      .returning();

    await markTokenRejected(db, one.id);

    expect((await reread(other[0]!.id)).tokenExpiresAt).toEqual(
      new Date('2027-01-09T09:00:00.000Z'),
    );
  });
});
