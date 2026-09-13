import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AiSandboxTurn, AiTurnField } from '@rakurs/contract';
import type { Db } from '../../db/client.js';
import { agents, aiSandboxSessions, aiSandboxTurns } from '../../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../../db/turn-cap.js';
import { ApiError } from '../errors.js';
import { HISTORY_LIMIT } from './prompt.js';
import { executeAiCore, type TurnDeps } from './turn.js';

/** A browser exchange never creates a contact, message, lead, order or transport call. */
export interface SimulatorInput {
  agentId: string;
  sessionId: string;
  text: string;
  revision: number;
}

const conflict = () => new ApiError(409, 'Сессия изменилась. Обновите её и попробуйте снова.');

/** Executes a production AI answer against only persisted, simulated conversation state. */
export async function runSimulatorTurn(
  db: Db, deps: TurnDeps, input: SimulatorInput,
): Promise<AiSandboxTurn> {
  const text = input.text.trim();
  if (text.length === 0 || text.length > 4_000 || !Number.isSafeInteger(input.revision)
    || input.revision < 0) {
    throw new ApiError(400, 'Напишите сообщение клиента и правильную версию сессии.');
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent) throw new ApiError(404, 'Агент не найден.');
  const scope = and(eq(aiSandboxSessions.id, input.sessionId),
    eq(aiSandboxSessions.agentId, agent.id), eq(aiSandboxSessions.accountId, agent.accountId));
  const [session] = await db.select().from(aiSandboxSessions).where(scope);
  if (!session) throw new ApiError(404, 'Сессия не найдена.');
  if (session.revision !== input.revision || session.archivedAt !== null
    || session.handoff !== null) throw conflict();
  if (agent.openrouterKey === null) {
    throw new ApiError(409, 'Ключ OpenRouter не задан. Добавьте его в настройках агента.');
  }

  if (!tryTakeTurnSlot()) {
    throw new ApiError(429, 'Песочница занята. Попробуйте через несколько секунд.');
  }
  try {
    const previous = await db.select().from(aiSandboxTurns)
      .where(and(eq(aiSandboxTurns.sessionId, session.id),
        eq(aiSandboxTurns.agentId, agent.id), eq(aiSandboxTurns.accountId, agent.accountId)))
      .orderBy(desc(aiSandboxTurns.revision)).limit(HISTORY_LIMIT);
    const history = previous.reverse().flatMap((turn) => [
      { author: 'client', body: turn.userText, kind: 'text' },
      ...(turn.reply === null ? [] : [{ author: 'ai', body: turn.reply, kind: 'text' }]),
    ]).concat({ author: 'client', body: text, kind: 'text' }).slice(-HISTORY_LIMIT);

    const core = await executeAiCore(db, deps, {
      agent, history, stageId: session.stageId, stageName: session.stageName,
      values: session.fields.map(({ id, name, value }) => ({ fieldId: id, name, value })),
      allowProposedCrm: true,
      // A browser rehearsal has no paid order or live conversation to confirm.
      canMoveToSuccess: async () => false,
    });

    const body = core.kind === 'ready' ? core.reply?.reply.trim() ?? '' : '';
    const withheld = core.kind === 'ready' && core.invented !== null;
    const reply = body === '' || withheld ? null : body;
    const handoff = core.kind === 'ready' ? core.handoffReason : null;
    const stage = core.kind === 'ready' ? core.targetStage : null;
    const fields: AiTurnField[] = core.kind === 'ready'
      ? Object.entries(core.fields).map(([id, value]) => ({
          id, name: core.fieldRows.find((field) => field.id === id)!.name, value,
        })) : [];
    const outcome = core.kind !== 'ready' ? core.kind
      : handoff !== null ? 'handoff' : body === '' ? 'applied' : 'sent';
    const details = core.kind === 'ready'
      ? [...core.details, ...(core.unreadableDetail === null ? [] : [core.unreadableDetail])]
      : [core.detail];
    if (core.kind === 'ready' && body === '' && core.reply !== null) {
      details.push('Модель не написала ответа клиенту.');
    }
    if (core.kind === 'ready' && core.invented !== null) {
      details.push(`в ответе есть число «${core.invented.slice(0, 40)}» без источника — ответ клиенту не отправлен.`);
    }
    const detail = details.length > 0 ? details.join(' ') : null;
    const merged = [...session.fields];
    for (const field of fields) {
      const at = merged.findIndex(({ id }) => id === field.id);
      if (at === -1) merged.push(field);
      else merged[at] = field;
    }

    // A concurrent invocation can spend a model call, but only one may persist the next
    // revision. The guarded update and the turn insert commit or roll back together.
    const stored = await db.transaction(async (tx) => {
      const [advanced] = await tx.update(aiSandboxSessions).set({
        revision: input.revision + 1,
        stageId: stage?.id ?? session.stageId,
        stageName: stage?.name ?? session.stageName,
        fields: merged,
        outcome,
        handoff,
        updatedAt: new Date(),
      }).where(and(scope, eq(aiSandboxSessions.revision, input.revision),
        isNull(aiSandboxSessions.archivedAt), isNull(aiSandboxSessions.handoff)))
        .returning({ revision: aiSandboxSessions.revision });
      if (!advanced) throw conflict();
      const [turn] = await tx.insert(aiSandboxTurns).values({
        accountId: agent.accountId, agentId: agent.id, sessionId: session.id,
        revision: advanced.revision, userText: text, reply,
        configVersion: agent.configVersion, model: agent.model,
        sourceIds: core.kind === 'ready' ? core.usedItemIds : [],
        stageId: stage?.id ?? null, stageName: stage?.name ?? null,
        fields, handoff, outcome, detail,
      }).returning();
      return turn!;
    });

    return {
      id: stored.id, revision: stored.revision, userText: stored.userText,
      reply: stored.reply, configVersion: stored.configVersion, model: stored.model,
      sourceIds: stored.sourceIds,
      usedItems: core.kind === 'ready' ? core.usedItems : [],
      stageId: stored.stageId, stageName: stored.stageName, fields: stored.fields,
      handoff: stored.handoff, outcome: stored.outcome, detail: stored.detail,
      createdAt: stored.createdAt.toISOString(),
    };
  } finally {
    releaseTurnSlot();
  }
}
