import type {
  Agent,
  CommunicationStyle,
  CommunicationStyleSettings,
  OperatorNotifySettings,
} from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agents } from '../db/schema.js';
import { normalizeOperatorPhone } from '../lib/ai/operator-alert.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import { ensureSealhousePaymentPolicy } from '../lib/payment-policy.js';
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

const communicationStylePatch = z.object({
  preset: z.enum(['warm', 'calm', 'friendly']),
});

const operatorNotifyPatch = z.object({
  phone: z.string().max(64),
});

const communicationStylePreview: Record<CommunicationStyle, string> = {
  warm: 'Здравствуйте! С радостью помогу 😊 Подскажите, что вас интересует?',
  calm: 'Здравствуйте. Подскажите, пожалуйста, что вас интересует?',
  friendly: 'Привет! Давайте разберёмся 🙂 Что именно вы ищете?',
};

const styleToApi = (preset: CommunicationStyle): CommunicationStyleSettings => ({
  preset,
  preview: communicationStylePreview[preset],
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
      if (row.name.trim().toLocaleLowerCase() === 'sealhouse') await ensureSealhousePaymentPolicy(db, row.id);
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
      if (row.name.trim().toLocaleLowerCase() === 'sealhouse') await ensureSealhousePaymentPolicy(db, row.id);
      return toApi(row);
    },
  );

  app.get(
    '/api/agents/:agentId/communication-style',
    { preHandler: [guard, requireAgent(db)] },
    async (req): Promise<CommunicationStyleSettings> => styleToApi(req.agent!.communicationStyle),
  );

  app.patch(
    '/api/agents/:agentId/communication-style',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async (req): Promise<CommunicationStyleSettings> => {
      const parsed = communicationStylePatch.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Выберите доступный стиль общения');
      if (parsed.data.preset === req.agent!.communicationStyle) return styleToApi(parsed.data.preset);

      await db.transaction(async (tx) => {
        const [updated] = await tx.update(agents).set({ communicationStyle: parsed.data.preset }).where(and(
          eq(agents.id, req.agent!.id),
          eq(agents.communicationStyle, req.agent!.communicationStyle),
        )).returning({ id: agents.id });
        if (!updated) throw new ApiError(409, 'Стиль общения уже изменился');
        await bumpConfigVersion(tx as unknown as Db, req.agent!.id);
      });
      return styleToApi(parsed.data.preset);
    },
  );
  // Read by any member, like the style: the card shows who gets the alerts to everyone who
  // works the conversations, and only the owner may change where they go.
  app.get(
    '/api/agents/:agentId/operator-notify',
    { preHandler: [guard, requireAgent(db)] },
    async (req): Promise<OperatorNotifySettings> => ({ phone: req.agent!.operatorNotifyPhone }),
  );

  app.patch(
    '/api/agents/:agentId/operator-notify',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async (req): Promise<OperatorNotifySettings> => {
      const parsed = operatorNotifyPatch.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите номер WhatsApp оператора');
      const normalized = normalizeOperatorPhone(parsed.data.phone);
      if (!normalized.ok) throw new ApiError(400, normalized.message);

      // No `configVersion` bump: the number never reaches the prompt, so no answer changes.
      const [updated] = await db
        .update(agents)
        .set({ operatorNotifyPhone: normalized.phone })
        .where(eq(agents.id, req.agent!.id))
        .returning({ phone: agents.operatorNotifyPhone });
      return { phone: updated?.phone ?? null };
    },
  );
}
