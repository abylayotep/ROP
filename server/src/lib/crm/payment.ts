import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { crmAnalyses } from '../../db/schema.js';
import { hasConfirmedKaspiPayment } from '../kaspi/service.js';

/** Money a lead may be moved into the sale stage on: Kaspi confirmed it, or the stored analysis saw it. */
export async function hasVisiblePayment(db: Db, agentId: string, conversationId: string): Promise<boolean> {
  if (await hasConfirmedKaspiPayment(db, agentId, conversationId)) return true;
  const [row] = await db.select({ profile: crmAnalyses.profile }).from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
  return row?.profile.paymentEvidence === 'paid' || row?.profile.paymentEvidence === 'confirmed';
}
