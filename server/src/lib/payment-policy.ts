import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRules, agents } from '../db/schema.js';

export const SEALHOUSE_PAYMENT_RULE = 'Оплата: перевод Kaspi — +77066241022, получатель Құралай А.; перевод Halyk/Народный — +77479041022, получатель Құралай А.; счёт выставляйте только через Kaspi POS. Не называйте намерение, обещание, реквизиты или присланный чек подтверждением оплаты.';

/** Add the deployment-specific rule only to the explicitly identified seller. */
export async function ensureSealhousePaymentPolicy(db: Db, explicitAgentId?: string): Promise<number> {
  const targets = explicitAgentId
    ? await db.select({id:agents.id}).from(agents).where(eq(agents.id, explicitAgentId))
    : await db.select({id:agents.id}).from(agents).where(sql`lower(trim(${agents.name})) = 'sealhouse'`);
  if (!explicitAgentId && targets.length !== 1) return 0;
  let inserted = 0;
  for (const target of targets) {
    const [existing] = await db.select({id:agentRules.id}).from(agentRules)
      .where(and(eq(agentRules.agentId,target.id),eq(agentRules.text,SEALHOUSE_PAYMENT_RULE))).limit(1);
    if (!existing) {
      await db.insert(agentRules).values({agentId:target.id,category:'business',text:SEALHOUSE_PAYMENT_RULE,origin:'manual',position:900});
      inserted += 1;
    }
  }
  return inserted;
}
