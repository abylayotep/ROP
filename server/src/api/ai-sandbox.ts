import type {
  AiSandboxSessionDetail, AiSandboxSessionSummary, AiSandboxTurn,
} from '@rakurs/contract';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { aiSandboxSessions, aiSandboxTurns, kbChunks } from '../db/schema.js';
import { runSimulatorTurn } from '../lib/ai/simulator.js';
import type { TurnDeps } from '../lib/ai/turn.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const createBody = z.object({
  title: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
});
const turnBody = z.object({
  text: z.string().trim().min(1).max(4_000),
  revision: z.number().int().nonnegative().safe(),
});

type SessionRow = typeof aiSandboxSessions.$inferSelect;
type TurnRow = typeof aiSandboxTurns.$inferSelect;

function summary(row: SessionRow): AiSandboxSessionSummary {
  return {
    id: row.id, title: row.title, phone: row.phone, revision: row.revision,
    stageId: row.stageId, stageName: row.stageName, fields: row.fields,
    outcome: row.outcome, handoff: row.handoff,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

function sessionId(req: { params: unknown }): string {
  const id = (req.params as { sessionId?: string }).sessionId;
  if (!id || !isUuid(id)) throw new ApiError(404, 'Сессия не найдена.');
  return id;
}

export function registerAiSandboxRoutes(
  app: FastifyInstance, db: Db, guard: preHandlerHookHandler, deps: TurnDeps,
): void {
  const preHandler = [guard, requireAgent(db, { role: 'owner' })];
  const base = '/api/agents/:agentId/ai/sandbox/sessions';

  app.get(base, { preHandler }, async (req): Promise<AiSandboxSessionSummary[]> => {
    const rows = await db.select().from(aiSandboxSessions)
      .where(and(eq(aiSandboxSessions.accountId, req.agent!.accountId),
        eq(aiSandboxSessions.agentId, req.agent!.id)))
      .orderBy(desc(aiSandboxSessions.updatedAt), desc(aiSandboxSessions.createdAt),
        desc(aiSandboxSessions.id));
    return rows.map(summary);
  });

  app.post(base, { preHandler }, async (req, reply): Promise<AiSandboxSessionSummary> => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Проверьте название и телефон сессии.');
    const [created] = await db.insert(aiSandboxSessions).values({
      accountId: req.agent!.accountId, agentId: req.agent!.id,
      title: parsed.data.title ?? '', phone: parsed.data.phone ?? null,
    }).returning();
    reply.code(201);
    return summary(created!);
  });

  app.get(`${base}/:sessionId`, { preHandler },
    async (req): Promise<AiSandboxSessionDetail> => {
      const id = sessionId(req);
      const [row] = await db.select().from(aiSandboxSessions).where(and(
        eq(aiSandboxSessions.id, id), eq(aiSandboxSessions.accountId, req.agent!.accountId),
        eq(aiSandboxSessions.agentId, req.agent!.id),
      ));
      if (!row) throw new ApiError(404, 'Сессия не найдена.');
      const turns = await db.select().from(aiSandboxTurns).where(and(
        eq(aiSandboxTurns.sessionId, id), eq(aiSandboxTurns.accountId, req.agent!.accountId),
        eq(aiSandboxTurns.agentId, req.agent!.id),
      )).orderBy(asc(aiSandboxTurns.revision));
      const ids = [...new Set(turns.flatMap((turn) => turn.sourceIds))];
      const chunks = ids.length === 0 ? [] : await db.select({ id: kbChunks.id, title: kbChunks.title })
        .from(kbChunks).where(and(eq(kbChunks.agentId, req.agent!.id), inArray(kbChunks.id, ids)));
      const titles = new Map(chunks.map((chunk) => [chunk.id, chunk.title]));
      const toTurn = (turn: TurnRow): AiSandboxTurn => ({
        id: turn.id, revision: turn.revision, userText: turn.userText,
        reply: turn.reply, configVersion: turn.configVersion, model: turn.model,
        sourceIds: turn.sourceIds,
        usedItems: turn.sourceIds.flatMap((sourceId) => {
          const title = titles.get(sourceId);
          return title === undefined ? [] : [{ id: sourceId, title }];
        }),
        stageId: turn.stageId, stageName: turn.stageName, fields: turn.fields,
        effectSource: turn.effectSource, checkout: turn.checkout,
        handoff: turn.handoff, outcome: turn.outcome, detail: turn.detail,
        createdAt: turn.createdAt.toISOString(),
      });
      return { ...summary(row), turns: turns.map(toTurn) };
    });

  app.post(`${base}/:sessionId/turns`, {
    preHandler,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req): Promise<AiSandboxTurn> => {
    const id = sessionId(req);
    const parsed = turnBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Напишите сообщение клиента и правильную версию сессии.');
    return runSimulatorTurn(db, deps, {
      agentId: req.agent!.id, sessionId: id,
      text: parsed.data.text, revision: parsed.data.revision,
    });
  });
}
