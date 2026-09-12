import { and, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { linkedHistoryPackets, whatsappNumbers } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { requireAgent } from './require-agent.js';

const params = z.object({ packetId: z.string().uuid() });
const replayableStatuses = ['partial', 'failed', 'done'];

type ArchiveCounts = {
  received: number;
  saved: number;
  duplicates: number;
  excluded: number;
  skippedUnresolved: number;
};

const emptyCounts: ArchiveCounts = {
  received: 0, saved: 0, duplicates: 0, excluded: 0, skippedUnresolved: 0,
};

function safeCounts(value: unknown): ArchiveCounts {
  if (!value || typeof value !== 'object') return emptyCounts;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(emptyCounts).map((key) => [
    key, typeof source[key] === 'number' ? source[key] : 0,
  ])) as ArchiveCounts;
}

export function registerWhatsappHistoryArchiveRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const member = requireAgent(db);
  const owner = requireAgent(db, { role: 'owner' });

  app.get('/api/agents/:agentId/whatsapp/history/archive', { preHandler: [guard, member] }, async (req) => {
    const now = new Date();
    const rows = await db.select({
      id: linkedHistoryPackets.id,
      numberId: linkedHistoryPackets.numberId,
      status: linkedHistoryPackets.status,
      counts: linkedHistoryPackets.counts,
      attempts: linkedHistoryPackets.attempts,
      errorCode: linkedHistoryPackets.errorCode,
      createdAt: linkedHistoryPackets.createdAt,
      expiresAt: linkedHistoryPackets.expiresAt,
      hasNotification: sql<boolean>`${linkedHistoryPackets.notification} is not null`,
      hasPayload: sql<boolean>`${linkedHistoryPackets.payload} is not null`,
    }).from(linkedHistoryPackets)
      .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, linkedHistoryPackets.numberId))
      .where(eq(whatsappNumbers.agentId, req.agent!.id))
      .orderBy(desc(linkedHistoryPackets.createdAt))
      .limit(50);

    return rows.map(({ hasNotification, hasPayload, counts, ...row }) => ({
      ...row,
      counts: safeCounts(counts),
      canReplay: replayableStatuses.includes(row.status)
        && row.expiresAt > now
        && (hasNotification || hasPayload),
    }));
  });

  app.post('/api/agents/:agentId/whatsapp/history/archive/:packetId/replay', {
    preHandler: [guard, owner],
  }, async (req) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) throw new ApiError(404, 'Пакет истории не найден.');
    const now = new Date();
    const [updated] = await db.update(linkedHistoryPackets).set({
      status: 'queued', attempts: 0, errorCode: null, updatedAt: now,
    }).where(and(
      eq(linkedHistoryPackets.id, parsed.data.packetId),
      inArray(linkedHistoryPackets.status, replayableStatuses),
      gt(linkedHistoryPackets.expiresAt, now),
      or(isNotNull(linkedHistoryPackets.notification), isNotNull(linkedHistoryPackets.payload)),
      inArray(linkedHistoryPackets.numberId,
        db.select({ id: whatsappNumbers.id }).from(whatsappNumbers).where(eq(whatsappNumbers.agentId, req.agent!.id))),
    )).returning({
      id: linkedHistoryPackets.id,
      numberId: linkedHistoryPackets.numberId,
      status: linkedHistoryPackets.status,
      counts: linkedHistoryPackets.counts,
      attempts: linkedHistoryPackets.attempts,
      errorCode: linkedHistoryPackets.errorCode,
      createdAt: linkedHistoryPackets.createdAt,
      expiresAt: linkedHistoryPackets.expiresAt,
    });
    if (updated) return { ...updated, counts: safeCounts(updated.counts), canReplay: false };

    const [visible] = await db.select({ id: linkedHistoryPackets.id }).from(linkedHistoryPackets)
      .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, linkedHistoryPackets.numberId))
      .where(and(eq(linkedHistoryPackets.id, parsed.data.packetId), eq(whatsappNumbers.agentId, req.agent!.id)))
      .limit(1);
    if (!visible) throw new ApiError(404, 'Пакет истории не найден.');
    throw new ApiError(409, 'Этот пакет уже нельзя обработать повторно.');
  });
}
