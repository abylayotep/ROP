import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AiSandboxTurn, AiTurnField } from '@rakurs/contract';
import type { Db } from '../../db/client.js';
import { agents, aiSandboxSessions, aiSandboxTurns } from '../../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../../db/turn-cap.js';
import { ApiError } from '../errors.js';
import { simulateCrmAnalysis } from '../crm/simulate.js';
import { holdingReply } from './holding.js';
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
      .orderBy(desc(aiSandboxTurns.revision)).limit(25);
    previous.reverse();
    const history = previous.flatMap((turn) => [
      { author: 'client', body: turn.userText, kind: 'text' },
      ...(turn.reply === null ? [] : [{ author: 'ai', body: turn.reply, kind: 'text' }]),
    ]).concat({ author: 'client', body: text, kind: 'text' }).slice(-HISTORY_LIMIT);

    const crm = deps.crm ? await simulateCrmAnalysis(db, deps, agent, session, previous, text) : null;
    const crmStageId = crm?.stage?.id ?? session.stageId;
    const crmStageName = crm?.stage?.name ?? session.stageName;
    const crmFields = [...session.fields];
    for (const field of crm?.fields ?? []) {
      const at = crmFields.findIndex(({ id }) => id === field.id);
      if (at === -1) crmFields.push(field);
      else crmFields[at] = field;
    }
    const core = crm?.error || crm?.checkout ? null : await executeAiCore(db, deps, {
      agent, history, stageId: crmStageId, stageName: crmStageName,
      values: crmFields.map(({ id, name, value }) => ({ fieldId: id, name, value })),
      allowProposedCrm: crm === null,
      // A rehearsal remembers its own photos, so it answers «уже отправлял» the way a live
      // conversation would.
      sentPhotoIds: previous.flatMap((turn) => turn.photoIds),
      // The script step is remembered the same way, so a rehearsal walks the script as a live
      // conversation does. Never paid: nothing in a rehearsal can be.
      scriptStepId: session.scriptStepId,
      paid: false,
      // A browser rehearsal has no paid order or live conversation to confirm.
      canMoveToSuccess: async () => false,
    });

    const body = core?.kind === 'ready' ? core.reply?.reply.trim() ?? '' : '';
    const withheld = core?.kind === 'ready' && core.invented !== null;
    // What a live turn sends when it has no reply it may send: a withheld number or a twice
    // unreadable answer puts the holding line in front of the customer, so the rehearsal shows
    // it as the agent's message. A failed call stays `failed` here, as in a draft check — the
    // owner is debugging the agent, not waiting on it.
    const held = core?.kind === 'ready' && (withheld || core.reply === null);
    const reply = held ? holdingReply(agent.replyLanguage, history) : body === '' ? null : body;
    // Photos go out only after a reply that goes out, so a withheld reply shows none.
    const photos = core?.kind === 'ready' && reply !== null && !held ? core.photos : [];
    const handoff = core?.kind === 'ready' ? core.handoffReason : null;
    const stage = crm?.stage ?? (core?.kind === 'ready' ? core.targetStage : null);
    const fields: AiTurnField[] = crm?.fields ?? (core?.kind === 'ready'
      ? Object.entries(core.fields).map(([id, value]) => ({
          id, name: core.fieldRows.find((field) => field.id === id)!.name, value,
        })) : []);
    const outcome = crm?.error ? 'failed' : crm?.checkout ? 'checkout' : core?.kind !== 'ready' ? core!.kind
      : handoff !== null ? 'handoff' : body === '' ? 'applied' : 'sent';
    const details = crm?.error ? [crm.error] : crm?.checkout
      ? [crm.checkout.status === 'would_create'
        ? 'Только предложение счёта: Kaspi не вызывался, заказ и платёж не созданы.'
        : 'Счёт не был бы создан: у клиента нет номера телефона.']
      : core?.kind === 'ready'
      ? [...core.details, ...(core.unreadableDetail === null ? [] : [core.unreadableDetail])]
      : [core!.detail];
    if (core?.kind === 'ready' && body === '' && core.reply !== null) {
      details.push('Модель не написала ответа клиенту.');
    }
    if (core?.kind === 'ready' && core.invented !== null) {
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
        // Moved only by a reply the customer would have received, as `runTurn` does.
        scriptStepId: core?.kind === 'ready' && reply !== null && !held && core.scriptStep !== null
          ? core.scriptStep.id : session.scriptStepId,
        fields: merged,
        ...(crm && !crm.error ? { crmSummary: crm.summary, crmProfile: crm.profile } : {}),
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
        sourceIds: core?.kind === 'ready' ? core.usedItemIds : [],
        stageId: stage?.id ?? null, stageName: stage?.name ?? null,
        fields, handoff, outcome, detail, effectSource: crm ? 'crm' : 'ai',
        checkout: crm?.checkout ?? null,
        photoIds: photos.map((photo) => photo.id),
      }).returning();
      return turn!;
    });

    return {
      id: stored.id, revision: stored.revision, userText: stored.userText,
      reply: stored.reply, configVersion: stored.configVersion, model: stored.model,
      sourceIds: stored.sourceIds,
      usedItems: core?.kind === 'ready' ? core.usedItems : [],
      stageId: stored.stageId, stageName: stored.stageName, fields: stored.fields,
      effectSource: stored.effectSource, checkout: stored.checkout,
      photos: photos.map(({ id, productId, productName }) => ({ id, productId, productName })),
      handoff: stored.handoff, outcome: stored.outcome, detail: stored.detail,
      createdAt: stored.createdAt.toISOString(),
    };
  } finally {
    releaseTurnSlot();
  }
}
