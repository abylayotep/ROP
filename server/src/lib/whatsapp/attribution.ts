import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { conversations } from '../../db/schema.js';

/** The referral block Meta attaches to the first message of a click-to-WhatsApp conversation. */
export interface Referral {
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

/**
 * Records the ad a conversation came from, once.
 *
 * Meta puts `referral` on the first message of a click-to-WhatsApp conversation and never
 * again, and `ctwa_clid` inside it is what stage 6 matches a purchase against — there is no
 * way to look it up afterwards. The `referral_seen_at is null` condition is what makes this
 * write-once: a later ad must not overwrite the one that actually paid for this client.
 *
 * A referral without a click id is still worth keeping: it names the ad for a human reading
 * the conversation, even though Meta cannot attribute a purchase to it.
 */
export async function recordReferral(
  db: Db,
  conversationId: string,
  referral: Referral,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      ctwaClid: referral.ctwa_clid ?? null,
      adSourceId: referral.source_id ?? null,
      adSourceType: referral.source_type ?? null,
      adHeadline: referral.headline ?? null,
      adBody: referral.body ?? null,
      referralSeenAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.referralSeenAt)));
}
