import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { whatsappNumbers } from '../../db/schema.js';
import { GraphError } from './graph.js';

/**
 * The deadline on a Meta token, and the moment Meta proves it has passed.
 *
 * A stored `token_expires_at` is a prediction: Meta stated it when the token was issued and
 * it is usually right. It is not the whole truth — a token also dies when the business user
 * behind it loses access, when the owner removes the application, or when Meta invalidates
 * a session early. In all of those the date in the database still reads «fine for another
 * month» while every send fails, which is the exact situation the column exists to prevent.
 *
 * So the date is corrected by what actually happens on the wire: the first Graph refusal
 * that says «this token is not valid» moves the deadline to now, and the cabinet starts
 * telling the owner to re-connect instead of quoting Meta's English at them.
 */

/**
 * Meta's code for a token that is no longer good: expired, revoked, or invalidated.
 *
 * One code, not a family. Every other OAuth-shaped failure means something the owner
 * cannot fix by re-connecting — 200 is a missing permission, 10 is an unapproved feature —
 * and marking the number dead for those would send them round a loop that changes nothing.
 */
const TOKEN_INVALID = 190;

export const isTokenRejection = (error: unknown): boolean =>
  error instanceof GraphError && error.code === TOKEN_INVALID;

/** What the cabinet says instead of quoting Meta. The cure is one button in «Интеграции». */
export const TOKEN_EXPIRED_MESSAGE =
  'Доступ Meta к номеру истёк. Подключите номер заново в интеграциях.';

/**
 * Records that this number's token is dead as of now.
 *
 * `least` rather than a plain assignment: a row whose deadline has already passed keeps the
 * earlier moment, so a number that has been failing for a week does not look freshly broken
 * every time somebody tries to send. Null — no deadline was ever known — becomes now, which
 * is the point of writing it at all.
 */
export async function markTokenRejected(db: Db, numberId: string): Promise<void> {
  await db
    .update(whatsappNumbers)
    .set({
      tokenExpiresAt: sql`least(coalesce(${whatsappNumbers.tokenExpiresAt}, now()), now())`,
    })
    .where(eq(whatsappNumbers.id, numberId));
}
