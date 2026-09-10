import type { Agent } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import { seedFunnel } from '../lib/funnel.js';
import { requireAccount } from './require-account.js';
import { requireAgent } from './require-agent.js';

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
  currency: row.currency,
});

export function registerAgentRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  app.get(
    '/api/accounts/:accountId/agents',
    { preHandler: [guard, requireAccount(db)] },
    async (req): Promise<Agent[]> => {
      const { accountId } = req.params as { accountId: string };

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
    { preHandler: [guard, requireAccount(db, { role: 'owner' })] },
    async (req): Promise<Agent> => {
      const { accountId } = req.params as { accountId: string };

      const parsed = create.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите название агента');

      // One transaction: an agent whose funnel failed to write would show an empty board
      // with no way to fill it from the cabinet.
      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(agents)
          .values({ accountId, ...parsed.data })
          .returning();
        await seedFunnel(tx, created!.id);
        return created!;
      });
      return toApi(row);
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

      // `name` and `timezone` are quoted verbatim into `roleSection` (`prompt.ts`) — «Ты —
      // продавец-консультант компании «{name}»» and «Часовой пояс компании: {timezone}» —
      // so either one changes what the agent would say for the same input and has to bump
      // `configVersion` the same way a knowledge note or a rule does. `description` never
      // reaches the prompt (`PromptAgent` has no field for it), so it deliberately does not
      // bump. Bumped inside the same transaction as the write it describes, as `knowledge.ts`
      // and `rules.ts` do.
      const bumps = parsed.data.name !== undefined || parsed.data.timezone !== undefined;
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(agents)
          .set(parsed.data)
          .where(eq(agents.id, req.agent!.id))
          .returning();
        if (bumps) await bumpConfigVersion(tx as unknown as Db, req.agent!.id);
        return updated!;
      });
      return toApi(row);
    },
  );
}
