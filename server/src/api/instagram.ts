import type { InstagramDirectAccount, InstagramDirectConnectResult } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { instagramAccounts } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { InstagramMessagingError, type InstagramMessagingClient } from '../lib/instagram/messaging-graph.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { GraphError, type GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';
import { isUuid } from '../lib/uuid.js';

const connectBody = z.object({ accessToken: z.string().trim().min(1),
  instagramAccountId: z.string().trim().optional() });
const settingsBody = z.object({ enabled: z.boolean() });

/** Map provider text to a fixed diagnostic label; never log or return the text itself. */
export function instagramOAuthFailureKind(error: unknown): string {
  if (!(error instanceof GraphError)) return 'transport_or_unknown';
  const message = error.message.toLowerCase();
  if (message.includes('redirect_uri') || message.includes('redirect uri')) return 'redirect_uri';
  if (message.includes('verification code') || message.includes('authorization code')) return 'verification_code';
  if (message.includes('client secret') || message.includes('app secret')) return 'app_secret';
  if (message.includes('app id') || message.includes('application id')) return 'app_id';
  if (message.includes('permission') || message.includes('scope')) return 'permission';
  return 'provider_other';
}

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
    if (!parsed.success) throw new ApiError(400, 'Не удалось получить токен Instagram. Обновите страницу и повторите вход через Meta.');
    let issued;
    try {
      issued = await graph.exchangeUserToken(parsed.data.accessToken, env.META_APP_ID, env.META_APP_SECRET);
    } catch (error) {
      req.log.warn({ stage: 'oauth_exchange', providerStatus: error instanceof GraphError ? error.status : null,
        providerCode: error instanceof GraphError ? error.code : null,
        failureKind: instagramOAuthFailureKind(error) }, 'Instagram connection failed');
      throw new ApiError(502, 'Meta не подтвердила доступ Instagram. Повторите вход через Facebook.');
    }
    let discovered;
    try {
      discovered = await messaging.discover(issued.token, (diagnostic) => {
        req.log.info({ stage: 'account_discovery', hasPagesReadEngagement: issued.hasPagesReadEngagement ?? null,
          ...diagnostic }, 'Instagram Page discovery metadata');
      }, issued.grantedPageIds);
    } catch (error) {
      req.log.warn({ stage: 'account_discovery', providerStatus: error instanceof InstagramMessagingError ? error.status : null,
        providerCode: error instanceof InstagramMessagingError ? error.code : null,
        providerSubcode: error instanceof InstagramMessagingError ? error.subcode : null }, 'Instagram connection failed');
      throw new ApiError(502, 'Meta не дала получить связанный Instagram. Проверьте доступ к Странице и аккаунту.');
    }
    if (discovered.length === 0) throw new ApiError(400, 'Не найден профессиональный Instagram, привязанный к странице Facebook.');
    if (!parsed.data.instagramAccountId && discovered.length > 1) return {
      account: null,
      choices: discovered.map(({ instagramUserId, username, pageName }) => ({ instagramUserId, username, pageName })),
    };
    const selected = discovered.find((entry) => entry.instagramUserId === (parsed.data.instagramAccountId ?? discovered[0]!.instagramUserId));
    if (!selected) throw new ApiError(400, 'Выбранный Instagram недоступен этому входу Meta.');
    const [existing] = await db.select({ agentId: instagramAccounts.agentId }).from(instagramAccounts)
      .where(eq(instagramAccounts.instagramUserId, selected.instagramUserId)).limit(1);
    if (existing && existing.agentId !== req.agent!.id) throw new ApiError(409, 'Этот Instagram подключён к другому агенту.');
    const encrypted = encryptSecret(selected.pageToken, credentialsKey(env), selected.instagramUserId);
    if (!existing) {
      const [staged] = await db.insert(instagramAccounts).values({
        agentId: req.agent!.id, instagramUserId: selected.instagramUserId, pageId: selected.pageId,
        username: selected.username, accessToken: encrypted, enabled: false, subscribedAt: null,
        updatedAt: new Date(),
      }).onConflictDoNothing({ target: instagramAccounts.instagramUserId }).returning();
      if (!staged) throw new ApiError(409, 'Этот Instagram уже подключается. Повторите попытку.');
    }
    try { await messaging.subscribe(selected.pageId, selected.pageToken, env.META_APP_ID); }
    catch (error) {
      req.log.warn({ stage: 'page_subscription', providerStatus: error instanceof InstagramMessagingError ? error.status : null,
        providerCode: error instanceof InstagramMessagingError ? error.code : null,
        providerSubcode: error instanceof InstagramMessagingError ? error.subcode : null }, 'Instagram connection failed');
      throw new ApiError(502, 'Meta не подтвердила подписку на сообщения Instagram. Проверьте права приложения.');
    }
    const [row] = await db.insert(instagramAccounts).values({
      agentId: req.agent!.id, instagramUserId: selected.instagramUserId, pageId: selected.pageId,
      username: selected.username, accessToken: encrypted, enabled: true, subscribedAt: new Date(), updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: instagramAccounts.instagramUserId,
      set: { agentId: req.agent!.id, pageId: selected.pageId, username: selected.username,
        accessToken: encrypted, enabled: true, subscribedAt: new Date(), updatedAt: new Date() },
      setWhere: eq(instagramAccounts.agentId, req.agent!.id),
    }).returning();
    if (!row) throw new ApiError(409, 'Этот Instagram подключён к другому агенту.');
    return { account: toApi(row) };
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
