import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { kaspiPayments, kaspiSessions } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { normalisePhone } from '../lib/kaspi/client.js';
import { activeSession, createKaspiCheckout, kaspiClient, paymentDto, reconcileKaspiPayment, sessionAad } from '../lib/kaspi/service.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { requireAgent } from './require-agent.js';
import { loadLead } from './leads.js';
import { isUuid } from '../lib/uuid.js';
export function registerKaspiRoutes(app: FastifyInstance, db: Db, env: Env, guard: preHandlerHookHandler) {
  const owner = { preHandler: [guard, requireAgent(db, { role: 'owner' })] };
  const member = { preHandler: [guard, requireAgent(db)] };
  const root = '/api/agents/:agentId/kaspi';
  app.get(`${root}/status`, member, async (req) => {
    const [row] = await db.select().from(kaspiSessions).where(eq(kaspiSessions.agentId, req.agent!.id));
    return { configured: !!env.KASPI_POS_URL, connected: !!row?.credentials, organization: row?.organization ?? null, phone: row?.phone ?? null };
  });
  app.post(`${root}/auth/init`, owner, async (req) => {
    const response = await kaspiClient(env).request('POST', '/api/auth/init');
    if (response.success !== true || response.view !== 'KPUniversalEnterPhoneNumber' || typeof response.processId !== 'string') throw new ApiError(502, 'Kaspi не начал авторизацию');
    await db.insert(kaspiSessions).values({ agentId: req.agent!.id, processId: response.processId, processExpiresAt: new Date(Date.now() + 10 * 60_000) }).onConflictDoUpdate({ target: kaspiSessions.agentId, set: { processId: response.processId, processExpiresAt: new Date(Date.now() + 10 * 60_000) } });
    return { ready: true };
  });
  async function challenge(agentId: string) {
    const [row] = await db.select().from(kaspiSessions).where(eq(kaspiSessions.agentId, agentId));
    if (!row?.processId || !row.processExpiresAt || row.processExpiresAt.getTime() < Date.now()) throw new ApiError(409, 'Начните подключение Kaspi заново');
    return row.processId;
  }
  app.post(`${root}/auth/send-phone`, owner, async (req) => {
    const parsed = z.object({ phone: z.string().max(32) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Укажите номер кассира');
    const phone = normalisePhone(parsed.data.phone);
    const response = await kaspiClient(env).request('POST', '/api/auth/send-phone', { processId: await challenge(req.agent!.id), phoneNumber: phone.slice(1) });
    if (response.success !== true || response.view !== 'EnterOtp') {
      await db.update(kaspiSessions).set({ processId: null, processExpiresAt: null }).where(eq(kaspiSessions.agentId, req.agent!.id));
      const body = z.object({ meta: z.object({ sn: z.string().optional() }).passthrough().optional(), data: z.object({ type: z.string().optional() }).passthrough().optional(), isClosed: z.boolean().optional() }).passthrough().safeParse(response.body);
      if (body.success && (body.data.meta?.sn === 'MobileOrgRegistration' || body.data.data?.type === 'kpOrgRegistration')) {
        throw new ApiError(400, 'Kaspi запросил регистрацию или подтверждение организации вместо SMS. Откройте Kaspi Pay под этим номером, проверьте доступ к магазину и завершите предложенные шаги. Затем подключите кассу заново.');
      }
      throw new ApiError(400, 'Kaspi не отправил SMS или завершил сессию. Проверьте номер кассира Kaspi Pay и начните подключение заново.');
    }
    await db.update(kaspiSessions).set({ phone }).where(eq(kaspiSessions.agentId, req.agent!.id));
    return { sent: true };
  });
  app.post(`${root}/auth/verify-otp`, owner, async (req) => {
    const parsed = z.object({ otp: z.string().regex(/^\d{4,8}$/) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Введите код из SMS');
    const response = await kaspiClient(env).request('POST', '/api/auth/verify-otp', { processId: await challenge(req.agent!.id), otp: parsed.data.otp });
    if (response.success !== true || typeof response.tokenSN !== 'string' || typeof response.vtokenSecret !== 'string') throw new ApiError(400, 'Kaspi не принял код');
    const [current] = await db.select().from(kaspiSessions).where(eq(kaspiSessions.agentId, req.agent!.id));
    const [open] = await db.select({ id: kaspiPayments.id }).from(kaspiPayments).where(and(eq(kaspiPayments.agentId, req.agent!.id), inArray(kaspiPayments.status, ['creating', 'unknown', 'pending']))).limit(1);
    if (open && (!response.organizationId || current?.merchantId !== String(response.organizationId))) throw new ApiError(409, 'Сначала завершите счета прежней организации Kaspi');
    const credentials = encryptSecret(JSON.stringify({ tokenSN: response.tokenSN, vtokenSecret: response.vtokenSecret, ...(response.profileId ? { profileId: String(response.profileId) } : {}) }), credentialsKey(env), sessionAad(req.agent!.id));
    await db.update(kaspiSessions).set({ credentials, merchantId: response.organizationId == null ? null : String(response.organizationId), organization: typeof response.orgName === 'string' ? response.orgName : null, processId: null, processExpiresAt: null, updatedAt: new Date() }).where(eq(kaspiSessions.agentId, req.agent!.id));
    return { connected: true };
  });
  app.delete(`${root}/session`, owner, async (req) => {
    await db.update(kaspiSessions).set({ credentials: null, processId: null, processExpiresAt: null, updatedAt: new Date() }).where(eq(kaspiSessions.agentId, req.agent!.id));
    return { connected: false };
  });
  app.post(`${root}/session/check`, owner, async (req) => {
    const response = await kaspiClient(env).request('GET', '/api/session/check', undefined, await activeSession(db, env, req.agent!.id));
    if (response.active === false) await db.update(kaspiSessions).set({ credentials: null, updatedAt: new Date() }).where(eq(kaspiSessions.agentId, req.agent!.id));
    return { active: response.active === true };
  });
  app.get(`${root}/payments`, member, async (req) => {
    const parsed = z.object({ conversationId: z.uuid() }).safeParse(req.query);
    if (!parsed.success) throw new ApiError(400, 'Укажите диалог');
    await loadLead(db, req.agent!, parsed.data.conversationId);
    const rows = await db.select().from(kaspiPayments).where(and(eq(kaspiPayments.agentId, req.agent!.id), eq(kaspiPayments.conversationId, parsed.data.conversationId))).orderBy(desc(kaspiPayments.createdAt));
    return { payments: rows.map(paymentDto) };
  });
  app.post(`${root}/payments`, member, async (req) => {
    const parsed = z.object({ conversationId: z.uuid(), amount: z.string(), phone: z.string().max(32).default(''), method: z.enum(['invoice', 'qr']).default('invoice'), requestKey: z.string().min(1).max(128), comment: z.string().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Проверьте данные счёта');
    return createKaspiCheckout(db, env, { ...parsed.data, agentId: req.agent!.id });
  });
  app.post(`${root}/payments/:paymentId/check`, member, async (req) => {
    const { paymentId } = req.params as { paymentId: string };
    if (!isUuid(paymentId)) throw new ApiError(404, 'Счёт не найден');
    return reconcileKaspiPayment(db, env, req.agent!.id, paymentId);
  });
}
