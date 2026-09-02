import type { Agent } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { accountMembers, agents } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { requireAgent } from './require-agent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const create = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().default(''),
  timezone: z.string().trim().min(1).default('Asia/Almaty'),
});

const patch = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  timezone: z.string().trim().min(1).optional(),
});

const toApi = (row: typeof agents.$inferSelect): Agent => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  description: row.description,
  timezone: row.timezone,
});

/**
 * Membership in an account, by the same rule the agent guard uses: a company you do not
 * belong to is answered 404, so the API never confirms that it exists.
 */
async function roleIn(db: Db, accountId: string, userId: string): Promise<string> {
  if (!UUID.test(accountId)) throw new ApiError(404, 'Компания не найдена');

  const [row] = await db
    .select({ role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  if (!row) throw new ApiError(404, 'Компания не найдена');
  return row.role;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  app.get(
    '/api/accounts/:accountId/agents',
    { preHandler: guard },
    async (req): Promise<Agent[]> => {
      const { accountId } = req.params as { accountId: string };
      await roleIn(db, accountId, req.user!.id);

      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.accountId, accountId))
        .orderBy(agents.name);
      return rows.map(toApi);
    },
  );

  app.post(
    '/api/accounts/:accountId/agents',
    { preHandler: guard },
    async (req): Promise<Agent> => {
      const { accountId } = req.params as { accountId: string };
      if ((await roleIn(db, accountId, req.user!.id)) !== 'owner') {
        throw new ApiError(403, 'Недостаточно прав');
      }

      const parsed = create.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите название агента');

      const [row] = await db
        .insert(agents)
        .values({ accountId, ...parsed.data })
        .returning();
      return toApi(row!);
    },
  );

  app.get(
    '/api/agents/:agentId',
    { preHandler: [guard, requireAgent(db)] },
    async (req): Promise<Agent> => toApi(req.agent!),
  );

  app.patch(
    '/api/agents/:agentId',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async (req): Promise<Agent> => {
      const parsed = patch.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки агента');

      // Drizzle raises on an UPDATE with nothing to set, and a request that changes
      // nothing is not an error — answer with the row as it stands.
      if (Object.keys(parsed.data).length === 0) return toApi(req.agent!);

      const [row] = await db
        .update(agents)
        .set(parsed.data)
        .where(eq(agents.id, req.agent!.id))
        .returning();
      return toApi(row!);
    },
  );
}
