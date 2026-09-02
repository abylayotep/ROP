import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { accountMembers } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The caller's role in the account this route is scoped to. Set by either guard. */
    membershipRole?: 'owner' | 'member';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Membership check for every `/api/accounts/:accountId/…` route.
 *
 * A preHandler rather than a helper the handler calls: later stages register routes under
 * this prefix, and a forgotten membership check has to be a route that will not register,
 * not a route that quietly answers everyone.
 *
 * A company the caller does not belong to answers 404, not 403, by the same rule as the
 * agent guard: a 403 would confirm the company exists. Only the role check answers 403, and
 * by then membership has already been proven.
 *
 * Runs after `requireSession`, which is what puts `req.user` in place.
 */
export function requireAccount(
  db: Db,
  options: { role?: 'owner' } = {},
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { accountId } = req.params as { accountId?: string };

    // The id comes from the URL. Comparing non-UUID text against a uuid column makes
    // Postgres raise, which would turn a typo into a 500.
    if (!accountId || !UUID.test(accountId)) {
      return reply.code(404).send({ message: 'Компания не найдена' });
    }

    const [row] = await db
      .select({ role: accountMembers.role })
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, req.user!.id)),
      );

    if (!row) return reply.code(404).send({ message: 'Компания не найдена' });

    if (options.role === 'owner' && row.role !== 'owner') {
      return reply.code(403).send({ message: 'Недостаточно прав' });
    }

    req.membershipRole = row.role === 'owner' ? 'owner' : 'member';
  };
}
