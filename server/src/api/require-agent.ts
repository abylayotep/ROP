import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { accountMembers, agents } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: typeof agents.$inferSelect;
  }
}
// `membershipRole` is declared once, in require-account.ts, and both guards attach it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Membership check for every `/api/agents/:agentId/…` route.
 *
 * A stranger's agent answers 404, not 403: a 403 would confirm the agent exists to
 * someone who has no business knowing that. Only the role check answers 403, and by then
 * the caller has already been shown to belong to the account.
 *
 * Runs after `requireSession`, which is what puts `req.user` in place.
 */
export function requireAgent(
  db: Db,
  options: { role?: 'owner' } = {},
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { agentId } = req.params as { agentId?: string };

    // The id comes from the URL. Comparing non-UUID text against a uuid column makes
    // Postgres raise, which would turn a typo into a 500.
    if (!agentId || !UUID.test(agentId)) {
      return reply.code(404).send({ message: 'Агент не найден' });
    }

    const [row] = await db
      .select({ agent: agents, role: accountMembers.role })
      .from(agents)
      .innerJoin(accountMembers, eq(accountMembers.accountId, agents.accountId))
      .where(and(eq(agents.id, agentId), eq(accountMembers.userId, req.user!.id)));

    if (!row) return reply.code(404).send({ message: 'Агент не найден' });

    if (options.role === 'owner' && row.role !== 'owner') {
      return reply.code(403).send({ message: 'Недостаточно прав' });
    }

    req.agent = row.agent;
    req.membershipRole = row.role === 'owner' ? 'owner' : 'member';
  };
}
