import { createHash } from 'node:crypto';
import type { KbGenerationRun } from '@rakurs/contract';
import { and, asc, count, eq, inArray, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  agents,
  conversations,
  kbGenerationBatches,
  kbGenerationProposals,
  kbGenerationRawFindings,
  kbGenerationRuns,
  kbNotes,
  messages,
} from '../../db/schema.js';
import { releaseTurnSlot, takeTurnSlotWaiting } from '../../db/turn-cap.js';
import type { ModelClient } from '../ai/openrouter.js';
import { keyAad } from '../ai/turn.js';
import { ApiError, isDuplicate } from '../errors.js';
import { decryptSecret } from '../secret-box.js';
import {
  consolidateGenerationProposals,
  GenerationConsolidationError,
  type ConsolidationUsage,
  type RawGenerationProposal,
} from './generation-consolidate.js';
import {
  extractGenerationBatch,
  GenerationExtractionError,
  type GenerationExtractionMessage,
  type GenerationExtractionUsage,
} from './generation-extract.js';
import { GENERATION_LIMITS } from './generation-limits.js';
import { generationContentHash, loadPreview } from './generation-selection.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from './generation-types.js';

export interface GenerationRunDeps {
  db: Db;
  model: ModelClient;
  credentialsKey: Buffer;
}

const fingerprint = (path: string, body: string): string =>
  createHash('sha256')
    .update(`${path.trim().toLocaleLowerCase('ru')}\n${body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru')}`)
    .digest('hex');

async function summary(db: Db, runId: string): Promise<KbGenerationRun> {
  const [run] = await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId));
  if (!run) throw new ApiError(404, 'Запуск не найден');
  const batches = await db.select({ status: kbGenerationBatches.status }).from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
  const [proposalCount] = await db.select({ value: count() }).from(kbGenerationProposals).where(and(
    eq(kbGenerationProposals.runId, runId),
    notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
  ));
  return {
    id: run.id,
    status: run.status as KbGenerationRun['status'],
    selection: run.selection,
    modelId: run.modelId,
    temperature: run.temperature,
    counts: run.counts,
    batchCount: batches.length,
    completedBatchCount: batches.filter((batch) => batch.status === 'done').length,
    failedBatchCount: batches.filter((batch) => batch.status === 'failed').length,
    proposalCount: Number(proposalCount?.value ?? 0),
    usage: { promptTokens: run.promptTokens, completionTokens: run.completionTokens, cost: run.cost },
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    errorCode: run.errorCode,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export const generationRunSummary = summary;

/** Database-guarded admission; replaying the same key returns the same durable run. */
export async function startGenerationRun(
  db: Db,
  agentId: string,
  userId: string,
  previewId: string,
  requestKey: string,
): Promise<KbGenerationRun> {
  const [existing] = await db.select().from(kbGenerationRuns).where(and(
    eq(kbGenerationRuns.agentId, agentId), eq(kbGenerationRuns.requestKey, requestKey),
  ));
  if (existing) {
    if (existing.requestedPreviewId !== previewId) throw new ApiError(409, 'Этот ключ уже использован для другого выбора');
    return summary(db, existing.id);
  }

  const preview = await loadPreview(db, agentId, previewId);
  const [agent] = await db.select({ temperature: agents.temperature }).from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new ApiError(404, 'Агент не найден');
  try {
    const runId = await db.transaction(async (tx) => {
      const [run] = await tx.insert(kbGenerationRuns).values({
        agentId,
        userId,
        requestedPreviewId: previewId,
        requestKey,
        selection: preview.selection,
        manifest: preview.manifest,
        counts: preview.counts,
        modelId: preview.modelId,
        temperature: agent.temperature,
      }).returning({ id: kbGenerationRuns.id });
      if (preview.manifest.batches.length > 0) {
        await tx.insert(kbGenerationBatches).values(preview.manifest.batches.map((batch) => ({
          runId: run!.id,
          ordinal: batch.ordinal,
          manifest: batch,
        })));
      }
      return run!.id;
    });
    return summary(db, runId);
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const [raced] = await db.select().from(kbGenerationRuns).where(and(
      eq(kbGenerationRuns.agentId, agentId), eq(kbGenerationRuns.requestKey, requestKey),
    ));
    if (raced) {
      if (raced.requestedPreviewId !== previewId) throw new ApiError(409, 'Этот ключ уже использован для другого выбора');
      return summary(db, raced.id);
    }
    throw new ApiError(409, 'Для агента уже идёт сбор базы знаний');
  }
}

async function addUsage(db: Db, runId: string, batchId: string, usage: GenerationExtractionUsage) {
  await db.transaction(async (tx) => {
    await tx.update(kbGenerationBatches).set({
      promptTokens: sql`${kbGenerationBatches.promptTokens} + ${usage.promptTokens}`,
      completionTokens: sql`${kbGenerationBatches.completionTokens} + ${usage.completionTokens}`,
      cost: sql`${kbGenerationBatches.cost} + ${usage.cost}`,
      updatedAt: new Date(),
    }).where(eq(kbGenerationBatches.id, batchId));
    await tx.update(kbGenerationRuns).set({
      promptTokens: sql`${kbGenerationRuns.promptTokens} + ${usage.promptTokens}`,
      completionTokens: sql`${kbGenerationRuns.completionTokens} + ${usage.completionTokens}`,
      cost: sql`${kbGenerationRuns.cost} + ${usage.cost}`,
      updatedAt: new Date(),
    }).where(eq(kbGenerationRuns.id, runId));
  });
}

async function addRunUsage(db: Db, runId: string, usage: ConsolidationUsage) {
  await db.update(kbGenerationRuns).set({
    promptTokens: sql`${kbGenerationRuns.promptTokens} + ${usage.promptTokens}`,
    completionTokens: sql`${kbGenerationRuns.completionTokens} + ${usage.completionTokens}`,
    cost: sql`${kbGenerationRuns.cost} + ${usage.cost}`,
    updatedAt: new Date(),
  }).where(eq(kbGenerationRuns.id, runId));
}

/** Executes pending batches sequentially. No failure is retried without an owner request. */
async function executeClaimedGenerationRun(deps: GenerationRunDeps, runId: string): Promise<void> {
  const { db } = deps;
  const [run] = await db.update(kbGenerationRuns)
    .set({ status: 'running', errorCode: null, updatedAt: new Date() })
    .where(and(eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.status, 'queued')))
    .returning();
  if (!run) return;
  const [agent] = await db.select({
    openrouterKey: agents.openrouterKey,
    communicationStyle: agents.communicationStyle,
  }).from(agents).where(eq(agents.id, run.agentId));
  if (!agent?.openrouterKey) {
    await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'missing_ai_configuration', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    return;
  }
  let key: string;
  try {
    key = decryptSecret(agent.openrouterKey, deps.credentialsKey, keyAad(run.agentId));
  } catch {
    await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'invalid_ai_configuration', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    return;
  }
  const batches = await db.select().from(kbGenerationBatches).where(and(
    eq(kbGenerationBatches.runId, runId), eq(kbGenerationBatches.status, 'pending'),
  )).orderBy(asc(kbGenerationBatches.ordinal));

  for (const batch of batches) {
    const [state] = await db.select({ cancelRequestedAt: kbGenerationRuns.cancelRequestedAt }).from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId));
    if (state?.cancelRequestedAt) {
      await db.update(kbGenerationRuns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
      return;
    }
    if (batch.attempts >= GENERATION_LIMITS.maxBatchAttempts) {
      await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'attempts_exhausted', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
      return;
    }
    const acquired = await takeTurnSlotWaiting(GENERATION_LIMITS.slotAcquisitionTimeoutMs);
    if (!acquired) {
      await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'slot_timeout', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
      return;
    }
    try {
      const [afterWait] = await db.select({ cancelRequestedAt: kbGenerationRuns.cancelRequestedAt }).from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId));
      if (afterWait?.cancelRequestedAt) {
        await db.update(kbGenerationRuns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
        return;
      }
      await db.update(kbGenerationBatches).set({ status: 'running', attempts: batch.attempts + 1, errorCode: null, updatedAt: new Date() }).where(eq(kbGenerationBatches.id, batch.id));
      const ids = batch.manifest.messages.map((entry) => entry.messageId);
      const sourceRows = ids.length === 0 ? [] : await db.select({
        id: messages.id,
        conversationId: messages.conversationId,
        author: messages.author,
        kind: messages.kind,
        sentAt: messages.sentAt,
        body: messages.body,
      }).from(messages).innerJoin(conversations, and(
        eq(conversations.id, messages.conversationId), eq(conversations.agentId, run.agentId),
      )).where(inArray(messages.id, ids));
      const byId = new Map(sourceRows.map((message) => [message.id, message]));
      const sourcesChanged = batch.manifest.messages.some((entry) => {
        const message = byId.get(entry.messageId);
        return !message || message.body === null || message.conversationId !== entry.conversationId ||
          generationContentHash({ ...message, body: message.body }) !== entry.contentHash;
      });
      if (sourcesChanged) throw new ApiError(409, 'История изменилась. Создайте новый запуск.');
      const input = batch.manifest.messages.map((entry) => byId.get(entry.messageId)!).map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        author: message.author as GenerationExtractionMessage['author'],
        sentAt: message.sentAt,
        body: message.body!,
      }));
      const result = await extractGenerationBatch({ model: deps.model, key, modelId: run.modelId, temperature: run.temperature }, input);
      await addUsage(db, runId, batch.id, result.usage);
      const sourceById = new Map(input.map((message) => [message.id, message]));
      const proposals = result.proposals.map((proposal) => ({
        runId,
        batchId: batch.id,
        fingerprint: fingerprint(proposal.path, proposal.body),
        path: proposal.path,
        body: proposal.body,
        warnings: proposal.warnings,
        sources: proposal.sourceMessageIds.map((id) => ({
          conversationId: sourceById.get(id)!.conversationId,
          messageId: id,
          sentAt: sourceById.get(id)!.sentAt.toISOString(),
        })),
      }));
      const cancelled = await db.transaction(async (tx) => {
        const [locked] = await tx.select({ at: kbGenerationRuns.cancelRequestedAt }).from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId)).for('update');
        if (locked?.at) {
          await tx.update(kbGenerationBatches).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(kbGenerationBatches.id, batch.id));
          await tx.update(kbGenerationRuns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
          return true;
        }
        if (proposals.length > 0) await tx.insert(kbGenerationRawFindings).values(proposals);
        await tx.update(kbGenerationBatches).set({
          status: 'done',
          classification: result.classification,
          classificationReason: result.classificationReason,
          updatedAt: new Date(),
        }).where(eq(kbGenerationBatches.id, batch.id));
        return false;
      });
      if (cancelled) return;
    } catch (error) {
      const code = error instanceof GenerationExtractionError ? error.code : 'batch_failed';
      if (error instanceof GenerationExtractionError) {
        await addUsage(db, runId, batch.id, error.usage);
        if (error.code !== 'invalid_batch') {
          await db.update(kbGenerationBatches).set({ status: 'done', errorCode: code, updatedAt: new Date() }).where(eq(kbGenerationBatches.id, batch.id));
          continue;
        }
      }
      await db.update(kbGenerationBatches).set({ status: 'failed', errorCode: code, updatedAt: new Date() }).where(eq(kbGenerationBatches.id, batch.id));
      await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: code, updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
      return;
    } finally {
      releaseTurnSlot();
    }
  }
  const rawRows = await db.select().from(kbGenerationRawFindings)
    .where(eq(kbGenerationRawFindings.runId, runId))
    .orderBy(asc(kbGenerationRawFindings.createdAt), asc(kbGenerationRawFindings.id));
  const finishWithoutItems = async () => {
    const completed = await db.update(kbGenerationRuns).set({ status: 'completed', updatedAt: new Date() }).where(and(
      eq(kbGenerationRuns.id, runId),
      eq(kbGenerationRuns.status, 'running'),
      sql`${kbGenerationRuns.cancelRequestedAt} is null`,
    )).returning({ id: kbGenerationRuns.id });
    if (completed.length === 0) {
      await db.update(kbGenerationRuns).set({ status: 'cancelled', updatedAt: new Date() }).where(and(
        eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.status, 'running'),
      ));
    }
  };
  if (rawRows.length === 0) {
    await finishWithoutItems();
    return;
  }

  const acquired = await takeTurnSlotWaiting(GENERATION_LIMITS.slotAcquisitionTimeoutMs);
  if (!acquired) {
    await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'slot_timeout', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    return;
  }
  try {
    const raw: RawGenerationProposal[] = rawRows.map((proposal) => ({
      id: proposal.id,
      kind: proposal.path.startsWith('Скрипт/') ? 'script' : 'knowledge',
      path: proposal.path,
      body: proposal.body,
      warnings: proposal.warnings,
      sources: proposal.sources,
    }));
    const result = await consolidateGenerationProposals({
      model: deps.model,
      key,
      modelId: run.modelId,
      temperature: run.temperature,
    }, { proposals: raw, communicationStyle: agent.communicationStyle });
    await addRunUsage(db, runId, result.usage);

    const candidateFingerprints = result.items.map((proposal) => fingerprint(proposal.path, proposal.body));
    const candidatePaths = [...new Set(result.items.map((proposal) => proposal.path))];
    const existingNotes = candidatePaths.length === 0 ? [] : await db.select({ path: kbNotes.path, body: kbNotes.body }).from(kbNotes).where(and(
      eq(kbNotes.agentId, run.agentId), inArray(kbNotes.path, candidatePaths),
    ));
    const prior = candidateFingerprints.length === 0 ? [] : await db.select({ fingerprint: kbGenerationProposals.fingerprint })
      .from(kbGenerationProposals)
      .innerJoin(kbGenerationRuns, and(eq(kbGenerationRuns.id, kbGenerationProposals.runId), eq(kbGenerationRuns.agentId, run.agentId)))
      .where(and(
        inArray(kbGenerationProposals.fingerprint, candidateFingerprints),
        inArray(kbGenerationProposals.status, ['pending', 'drafted']),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ));
    const seen = new Set([
      ...existingNotes.map((note) => fingerprint(note.path, note.body)),
      ...prior.map((row) => row.fingerprint),
    ]);
    const rawById = new Map(rawRows.map((proposal) => [proposal.id, proposal]));
    const finalRows = result.items.filter((proposal) => {
      const key = fingerprint(proposal.path, proposal.body);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((proposal) => ({
      runId,
      batchId: rawById.get(proposal.sourceProposalIds[0]!)!.batchId,
      fingerprint: fingerprint(proposal.path, proposal.body),
      kind: proposal.kind,
      path: proposal.path,
      body: proposal.body,
      confidence: proposal.confidence,
      selected: proposal.selected,
      warnings: proposal.warnings,
      sources: proposal.sources,
    }));
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ at: kbGenerationRuns.cancelRequestedAt }).from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId)).for('update');
      if (locked?.at) {
        await tx.update(kbGenerationRuns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
        return;
      }
      if (finalRows.length > 0) await tx.insert(kbGenerationProposals).values(finalRows).onConflictDoNothing();
      await tx.update(kbGenerationRuns).set({ status: 'completed', updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    });
  } catch (error) {
    if (error instanceof GenerationConsolidationError) {
      await addRunUsage(db, runId, error.usage);
      await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'consolidation_failed', updatedAt: new Date() }).where(and(
        eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.status, 'running'),
      ));
      return;
    }
    throw error;
  } finally {
    releaseTurnSlot();
  }
}

export async function executeGenerationRun(deps: GenerationRunDeps, runId: string): Promise<void> {
  try {
    await executeClaimedGenerationRun(deps, runId);
  } catch (error) {
    await deps.db.update(kbGenerationRuns).set({
      status: 'failed', errorCode: 'unexpected', updatedAt: new Date(),
    }).where(and(eq(kbGenerationRuns.id, runId), inArray(kbGenerationRuns.status, ['queued', 'running']))).catch(() => undefined);
    throw error;
  }
}

export async function cancelGenerationRun(db: Db, agentId: string, runId: string): Promise<KbGenerationRun> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(kbGenerationRuns).where(and(eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.agentId, agentId))).for('update');
    if (!run) throw new ApiError(404, 'Запуск не найден');
    if (run.status === 'queued') {
      await tx.update(kbGenerationRuns).set({ status: 'cancelled', cancelRequestedAt: new Date(), updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    } else if (run.status === 'running' && !run.cancelRequestedAt) {
      await tx.update(kbGenerationRuns).set({ cancelRequestedAt: new Date(), updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    }
  });
  return summary(db, runId);
}

export async function retryGenerationRun(db: Db, agentId: string, runId: string): Promise<KbGenerationRun> {
  try {
    await db.transaction(async (tx) => {
    const [run] = await tx.select().from(kbGenerationRuns).where(and(eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.agentId, agentId))).for('update');
    if (!run) throw new ApiError(404, 'Запуск не найден');
    if (run.status !== 'failed') return;
    const unfinished = await tx.select({ id: kbGenerationBatches.id, attempts: kbGenerationBatches.attempts }).from(kbGenerationBatches).where(and(
      eq(kbGenerationBatches.runId, runId), inArray(kbGenerationBatches.status, ['pending', 'failed', 'running']),
    ));
    const [rawState] = await tx.select({ value: count() }).from(kbGenerationRawFindings)
      .where(eq(kbGenerationRawFindings.runId, runId));
    const [proposalState] = await tx.select({ value: count() }).from(kbGenerationProposals).where(and(
      eq(kbGenerationProposals.runId, runId),
      notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
    ));
    const consolidationOnly = unfinished.length === 0 &&
      Number(rawState?.value ?? 0) > 0 && Number(proposalState?.value ?? 0) === 0;
    if (
      (!consolidationOnly && unfinished.length === 0) ||
      unfinished.some((batch) => batch.attempts >= GENERATION_LIMITS.maxBatchAttempts)
    ) {
      throw new ApiError(409, 'Попытки исчерпаны. Создайте новый запуск.');
    }
    if (unfinished.length > 0) {
      await tx.update(kbGenerationBatches).set({ status: 'pending', errorCode: null, updatedAt: new Date() }).where(inArray(kbGenerationBatches.id, unfinished.map((batch) => batch.id)));
    }
    await tx.update(kbGenerationRuns).set({ status: 'queued', errorCode: null, cancelRequestedAt: null, updatedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));
    });
  } catch (error) {
    if (isDuplicate(error)) throw new ApiError(409, 'Для агента уже идёт сбор базы знаний');
    throw error;
  }
  return summary(db, runId);
}

/** No paid work resumes implicitly after a process restart. */
export async function reconcileGenerationRuns(db: Db): Promise<number> {
  await db.update(kbGenerationBatches).set({ status: 'failed', errorCode: 'interrupted', updatedAt: new Date() }).where(eq(kbGenerationBatches.status, 'running'));
  const rows = await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'interrupted', updatedAt: new Date() }).where(inArray(kbGenerationRuns.status, ['queued', 'running'])).returning({ id: kbGenerationRuns.id });
  return rows.length;
}
