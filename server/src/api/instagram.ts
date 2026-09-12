import type { InstagramDirectAccount, InstagramDirectConnectResult } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { instagramAccounts } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import type { InstagramMessagingClient } from '../lib/instagram/messaging-graph.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import type { GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';
import { isUuid } from '../lib/uuid.js';

const connectBody = z.object({ code: z.string().trim().min(1), instagramAccountId: z.string().trim().optional() });
const settingsBody = z.object({ enabled: z.boolean() });

const toApi = (row: typeof instagramAccounts.$inferSelect): InstagramDirectAccount => ({
  id: row.id,
  instagramUserId: row.instagramUserId,
  username: row.username,
  enabled: row.enabled,
  subscribed: row.subscribedAt !== null,
  tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
});

export function registerInstagramRoutes(
  app: FastifyInstance, db: Db, env: Env, guard: preHandlerHookHandler,
  graph: GraphClient, messaging: InstagramMessagingClient,
): void {
  const member = requireAgent(db);
  const owner = requireAgent(db, { role: 'owner' });

  app.get('/api/agents/:agentId/instagram', { preHandler: [guard, member] }, async (req) => {
    const rows = await db.select().from(instagramAccounts)
      .where(eq(instagramAccounts.agentId, req.agent!.id)).orderBy(instagramAccounts.createdAt);
    return rows.map(toApi);
  });

  app.post('/api/agents/:agentId/instagram/connect', { preHandler: [guard, owner] }, async (req): Promise<InstagramDirectConnectResult> => {
    const parsed = connectBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Meta не вернула код входа');
    let discovered;
    try {
      const issued = await graph.exchangeCode(parsed.data.code, env.META_APP_ID, env.META_APP_SECRET);
      discovered = await messaging.discover(issued.token);
    } catch {
      throw new ApiError(502, 'Meta не подключила Instagram. Проверьте права приложения и попробуйте снова.');
    }
    if (discovered.length === 0) throw new ApiError(400, 'Не найден профессиональный Instagram, привязанный к странице Facebook.');
    if (!parsed.data.instagramAccountId && discovered.length > 1) return {
      account: null,
      choices: discovered.map(({ instagramUserId, username, pageName }) => ({ instagramUserId, username, pageName })),
    };
    const selected = discovered.find((entry) => entry.instagramUserId === (parsed.data.instagramAccountId ?? discovered[0]!.instagramUserId));
    if (!selected) throw new ApiError(400, 'Выбранный Instagram недоступен этому входу Meta.');
    const encrypted = encryptSecret(selected.pageToken, credentialsKey(env), selected.instagramUserId);
    const [row] = await db.insert(instagramAccounts).values({
      agentId: req.agent!.id, instagramUserId: selected.instagramUserId, pageId: selected.pageId,
      username: selected.username, accessToken: encrypted, subscribedAt: null, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: instagramAccounts.instagramUserId,
      set: { agentId: req.agent!.id, pageId: selected.pageId, username: selected.username,
        accessToken: encrypted, enabled: true, subscribedAt: null, updatedAt: new Date() },
      setWhere: eq(instagramAccounts.agentId, req.agent!.id),
    }).returning();
    if (!row) throw new ApiError(409, 'Этот Instagram подключён к другому агенту.');
    try { await messaging.subscribe(selected.pageId, selected.pageToken, env.META_APP_ID); }
    catch { throw new ApiError(502, 'Meta не подтвердила подписку на сообщения Instagram. Проверьте права приложения.'); }
    const [ready] = await db.update(instagramAccounts).set({ subscribedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(instagramAccounts.id, row.id), eq(instagramAccounts.agentId, req.agent!.id))).returning();
    return { account: toApi(ready!) };
  });

  app.patch('/api/agents/:agentId/instagram/:accountId', { preHandler: [guard, owner] }, async (req) => {
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Некорректная настройка Instagram');
    const { accountId } = req.params as { accountId: string };
    if (!isUuid(accountId)) throw new ApiError(404, 'Instagram не найден');
    const [row] = await db.update(instagramAccounts).set({ enabled: parsed.data.enabled, updatedAt: new Date() })
      .where(and(eq(instagramAccounts.id, accountId), eq(instagramAccounts.agentId, req.agent!.id))).returning();
    if (!row) throw new ApiError(404, 'Instagram не найден');
    return toApi(row);
  });
}
