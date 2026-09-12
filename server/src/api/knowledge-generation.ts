import type {
  KbGenerationDraftLink,
  KbGenerationDraftLinkPage,
  KbGenerationExclusion,
  KbGenerationExclusionPage,
  KbGenerationProposal,
  KbGenerationProposalPage,
  KbGenerationRawFinding,
  KbGenerationRawFindingPage,
  KbGenerationRunPage,
  KbGenerationRunDetail,
  KbGenerationRunSummary,
} from '@rakurs/contract';
import { and, asc, count, desc, eq, inArray, isNull, lte, notLike, or, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  conversations,
  kbDrafts,
  kbGenerationBatches,
  kbGenerationDrafts,
  kbGenerationProposals,
  kbGenerationRawFindings,
  kbGenerationRuns,
  kbNotes,
  messages,
} from '../db/schema.js';
import type { Env } from '../env.js';
import type { ModelClient } from '../lib/ai/openrouter.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey } from '../lib/secret-box.js';
import {
  cancelGenerationRun,
  executeGenerationRun,
  retryGenerationRun,
  startGenerationRun,
} from '../lib/knowledge/generation-run.js';
import { createGenerationDraft, updateGenerationProposal } from '../lib/knowledge/generation-review.js';
import { previewSelection } from '../lib/knowledge/generation-selection.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from '../lib/knowledge/generation-types.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const previewBody = z.object({
  conversationIds: z.array(z.string().uuid()).min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
});
const startBody = z.object({ previewId: z.string().uuid(), requestKey: z.string().trim().min(1).max(200) });
const proposalUpdateBody = z.object({
  revision: z.number().int().positive(),
  path: z.string().optional(),
  body: z.string().optional(),
  selected: z.boolean().optional(),
  status: z.enum(['pending', 'rejected']).optional(),
});
const draftBody = z.object({
  proposalIds: z.array(z.string().uuid()),
  revisions: z.record(z.string().uuid(), z.number().int().positive()),
  updateTargets: z.record(z.string().uuid(), z.string().uuid()).optional(),
});
const PAGE_SIZE = 20;

const cursorOffset = (cursor: unknown): number => {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw new ApiError(400, 'Некорректный курсор');
  return Number(cursor);
};

const after = (offset: number, count: number): string | null => count > PAGE_SIZE ? String(offset + PAGE_SIZE) : null;

const toDraftLink = (row: { id: string; title: string; status: string; createdAt: Date }): KbGenerationDraftLink => ({
  id: row.id,
  title: row.title,
  status: row.status as KbGenerationDraftLink['status'],
  createdAt: row.createdAt.toISOString(),
});

async function generationDraftPage(db: Db, agentId: string, runId: string, offset: number): Promise<KbGenerationDraftLinkPage> {
  const fields = {
    id: kbDrafts.id,
    title: kbDrafts.title,
    status: kbDrafts.status,
    createdAt: kbDrafts.createdAt,
  };
  const rows = await db.select(fields).from(kbGenerationDrafts)
    .innerJoin(kbGenerationRuns, and(
      eq(kbGenerationRuns.id, kbGenerationDrafts.runId),
      eq(kbGenerationRuns.agentId, agentId),
    ))
    .innerJoin(kbDrafts, and(
      eq(kbDrafts.id, kbGenerationDrafts.draftId),
      eq(kbDrafts.agentId, agentId),
    ))
    .where(eq(kbGenerationDrafts.runId, runId))
    .orderBy(desc(kbDrafts.createdAt), desc(kbDrafts.id))
    .limit(PAGE_SIZE + 1).offset(offset);
  return { items: rows.slice(0, PAGE_SIZE).map(toDraftLink), nextCursor: after(offset, rows.length) };
}

async function draftPagesForRuns(db: Db, agentId: string, runIds: string[]): Promise<Map<string, KbGenerationDraftLinkPage>> {
  const pages = new Map<string, KbGenerationDraftLinkPage>(runIds.map((runId) => [runId, { items: [], nextCursor: null }]));
  if (runIds.length === 0) return pages;
  const ranked = db.select({
    runId: kbGenerationDrafts.runId,
    id: kbDrafts.id,
    title: kbDrafts.title,
    status: kbDrafts.status,
    createdAt: kbDrafts.createdAt,
    rank: sql<number>`row_number() over (partition by ${kbGenerationDrafts.runId} order by ${kbDrafts.createdAt} desc, ${kbDrafts.id} desc)`.as('draft_rank'),
  }).from(kbGenerationDrafts)
    .innerJoin(kbGenerationRuns, and(
      eq(kbGenerationRuns.id, kbGenerationDrafts.runId),
      eq(kbGenerationRuns.agentId, agentId),
    ))
    .innerJoin(kbDrafts, and(
      eq(kbDrafts.id, kbGenerationDrafts.draftId),
      eq(kbDrafts.agentId, agentId),
    ))
    .where(inArray(kbGenerationDrafts.runId, runIds))
    .as('ranked_generation_drafts');
  const rows = await db.select().from(ranked).where(lte(ranked.rank, PAGE_SIZE + 1))
    .orderBy(asc(ranked.runId), asc(ranked.rank));
  for (const runId of runIds) {
    const matches = rows.filter((row) => row.runId === runId);
    pages.set(runId, {
      items: matches.slice(0, PAGE_SIZE).map(toDraftLink),
      nextCursor: matches.length > PAGE_SIZE ? String(PAGE_SIZE) : null,
    });
  }
  return pages;
}

async function reviewRunSummaries(db: Db, agentId: string, runIds: string[]): Promise<KbGenerationRunSummary[]> {
  if (runIds.length === 0) return [];
  const [runs, batches, proposalCounts, draftPages] = await Promise.all([
    db.select().from(kbGenerationRuns).where(and(
      eq(kbGenerationRuns.agentId, agentId),
      inArray(kbGenerationRuns.id, runIds),
    )),
    db.select({
      runId: kbGenerationBatches.runId,
      id: kbGenerationBatches.id,
      ordinal: kbGenerationBatches.ordinal,
      status: kbGenerationBatches.status,
      classification: kbGenerationBatches.classification,
      errorCode: kbGenerationBatches.errorCode,
    }).from(kbGenerationBatches).where(inArray(kbGenerationBatches.runId, runIds)),
    db.select({ runId: kbGenerationProposals.runId, value: count() }).from(kbGenerationProposals)
      .where(and(
        inArray(kbGenerationProposals.runId, runIds),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      )).groupBy(kbGenerationProposals.runId),
    draftPagesForRuns(db, agentId, runIds),
  ]);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const countsByRun = new Map(proposalCounts.map((row) => [row.runId, Number(row.value)]));
  return runIds.map((runId) => {
    const run = byId.get(runId)!;
    const runBatches = batches.filter((batch) => batch.runId === runId);
    const classificationCounts = { customer: 0, irrelevant: 0, uncertain: 0 };
    for (const batch of runBatches) {
      const classification = batch.classification ?? (batch.status === 'done' ? 'uncertain' : null);
      if (classification) classificationCounts[classification] += 1;
    }
    const drafts = draftPages.get(runId)!;
    return {
      id: run.id,
      status: run.status as KbGenerationRunSummary['status'],
      selection: run.selection,
      modelId: run.modelId,
      temperature: run.temperature,
      counts: run.counts,
      batchCount: runBatches.length,
      completedBatchCount: runBatches.filter((batch) => batch.status === 'done').length,
      failedBatchCount: runBatches.filter((batch) => batch.status === 'failed').length,
      proposalCount: countsByRun.get(runId) ?? 0,
      usage: { promptTokens: run.promptTokens, completionTokens: run.completionTokens, cost: run.cost },
      cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
      errorCode: run.errorCode,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      classificationCounts,
      excludedBatchCount: classificationCounts.irrelevant + classificationCounts.uncertain,
      errors: [
        ...(run.errorCode ? [{ batchId: null, ordinal: null, code: run.errorCode }] : []),
        ...runBatches.flatMap((batch) => batch.errorCode ? [{
          batchId: batch.id,
          ordinal: batch.ordinal,
          code: batch.errorCode,
        }] : []),
      ],
      drafts: drafts.items,
      draftsNextCursor: drafts.nextCursor,
    };
  });
}

async function exclusionPage(db: Db, agentId: string, runId: string, offset: number): Promise<KbGenerationExclusionPage> {
  const batches = await db.select({
    id: kbGenerationBatches.id,
    ordinal: kbGenerationBatches.ordinal,
    status: kbGenerationBatches.status,
    classification: kbGenerationBatches.classification,
    reason: kbGenerationBatches.classificationReason,
  }).from(kbGenerationBatches)
    .innerJoin(kbGenerationRuns, and(
      eq(kbGenerationRuns.id, kbGenerationBatches.runId),
      eq(kbGenerationRuns.agentId, agentId),
    ))
    .where(and(
      eq(kbGenerationBatches.runId, runId),
      or(
        inArray(kbGenerationBatches.classification, ['irrelevant', 'uncertain']),
        and(isNull(kbGenerationBatches.classification), eq(kbGenerationBatches.status, 'done')),
      ),
    ))
    .orderBy(asc(kbGenerationBatches.ordinal), asc(kbGenerationBatches.id))
    .limit(PAGE_SIZE + 1).offset(offset);
  const items = batches.slice(0, PAGE_SIZE).map((batch): KbGenerationExclusion => {
    const classification = (batch.classification ?? 'uncertain') as KbGenerationExclusion['classification'];
    return {
      batchId: batch.id,
      ordinal: batch.ordinal,
      classification,
      reason: batch.reason ?? 'Более ранний запуск',
    };
  });
  return { items, nextCursor: after(offset, batches.length) };
}

async function rawFindingPage(db: Db, agentId: string, runId: string, offset: number): Promise<KbGenerationRawFindingPage> {
  const rows = await db.select({ finding: kbGenerationRawFindings }).from(kbGenerationRawFindings)
    .innerJoin(kbGenerationRuns, and(
      eq(kbGenerationRuns.id, kbGenerationRawFindings.runId),
      eq(kbGenerationRuns.agentId, agentId),
    ))
    .where(eq(kbGenerationRawFindings.runId, runId))
    .orderBy(asc(kbGenerationRawFindings.createdAt), asc(kbGenerationRawFindings.id))
    .limit(PAGE_SIZE + 1).offset(offset);
  const visible = rows.slice(0, PAGE_SIZE);
  const sourceIds = [...new Set(visible.flatMap(({ finding }) => finding.sources.map((source) => source.messageId)))];
  const sourceRows = sourceIds.length === 0 ? [] : await db.select({
    id: messages.id,
    conversationId: messages.conversationId,
    body: messages.body,
  }).from(messages).innerJoin(conversations, and(
    eq(conversations.id, messages.conversationId),
    eq(conversations.agentId, agentId),
  )).where(inArray(messages.id, sourceIds));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const items = visible.map(({ finding }) => ({
    id: finding.id,
    path: finding.path,
    body: finding.body,
    warnings: finding.warnings,
    legacyProvenance: finding.legacyStatus === null ? null : {
      kind: finding.legacyKind ?? (finding.path.startsWith('Скрипт/') ? 'script' as const : 'knowledge' as const),
      revision: finding.legacyRevision ?? 1,
      status: finding.legacyStatus,
      draftId: finding.legacyDraftId,
      draftOpIndex: finding.legacyDraftOpIndex,
      noteId: finding.legacyNoteId,
    },
    sources: finding.sources.map((source) => ({
      ...source,
      excerpt: sourceById.get(source.messageId)?.body?.slice(0, 240) ?? null,
      available: sourceById.get(source.messageId)?.conversationId === source.conversationId,
    })),
  }));
  return { items, nextCursor: after(offset, rows.length) };
}

async function proposalPage(db: Db, agentId: string, runId: string, offset: number): Promise<KbGenerationProposalPage> {
  const rows = await db.select({ proposal: kbGenerationProposals }).from(kbGenerationProposals)
    .innerJoin(kbGenerationRuns, and(eq(kbGenerationRuns.id, kbGenerationProposals.runId), eq(kbGenerationRuns.agentId, agentId)))
    .where(and(
      eq(kbGenerationProposals.runId, runId),
      notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
    ))
    .orderBy(desc(kbGenerationProposals.createdAt), desc(kbGenerationProposals.id))
    .limit(PAGE_SIZE + 1).offset(offset);
  const visible = rows.slice(0, PAGE_SIZE).map((row) => row.proposal);
  const sourceIds = [...new Set(visible.flatMap((proposal) => proposal.sources.map((source) => source.messageId)))];
  const sourceRows = sourceIds.length === 0 ? [] : await db.select({
    id: messages.id,
    conversationId: messages.conversationId,
    sentAt: messages.sentAt,
    body: messages.body,
  }).from(messages).innerJoin(conversations, and(
    eq(conversations.id, messages.conversationId), eq(conversations.agentId, agentId),
  )).where(inArray(messages.id, sourceIds));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const paths = [...new Set(visible.map((proposal) => proposal.path))];
  const noteRows = paths.length === 0 ? [] : await db.select({ id: kbNotes.id, path: kbNotes.path, title: kbNotes.title, body: kbNotes.body })
    .from(kbNotes).where(and(eq(kbNotes.agentId, agentId), inArray(kbNotes.path, paths)));
  const notesByPath = new Map(noteRows.map((note) => [note.path, note]));
  const items: KbGenerationProposal[] = visible.map((proposal) => ({
    id: proposal.id,
    revision: proposal.revision,
    kind: proposal.kind,
    path: proposal.path,
    body: proposal.body,
    confidence: proposal.confidence,
    selected: proposal.selected,
    sources: proposal.sources.map((source) => {
      const current = sourceById.get(source.messageId);
      return {
        conversationId: source.conversationId,
        messageId: source.messageId,
        sentAt: source.sentAt,
        excerpt: current?.body?.slice(0, 240) ?? null,
        available: current?.conversationId === source.conversationId,
      };
    }),
    warnings: proposal.warnings,
    matches: notesByPath.has(proposal.path) ? [{
      noteId: notesByPath.get(proposal.path)!.id,
      path: proposal.path,
      title: notesByPath.get(proposal.path)!.title,
      exact: notesByPath.get(proposal.path)!.body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru') === proposal.body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'),
    }] : [],
    status: proposal.status as KbGenerationProposal['status'],
    draftId: proposal.draftId,
    noteId: proposal.noteId,
  }));
  return { items, nextCursor: after(offset, rows.length) };
}

async function oneProposal(db: Db, agentId: string, proposalId: string): Promise<KbGenerationProposal> {
  const rows = await db.select({ proposal: kbGenerationProposals }).from(kbGenerationProposals)
    .innerJoin(kbGenerationRuns, and(eq(kbGenerationRuns.id, kbGenerationProposals.runId), eq(kbGenerationRuns.agentId, agentId)))
    .where(and(
      eq(kbGenerationProposals.id, proposalId),
      notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
    ));
  if (!rows[0]) throw new ApiError(404, 'Предложение не найдено');
  const proposal = rows[0].proposal;
  const sourceIds = proposal.sources.map((source) => source.messageId);
  const sourceRows = sourceIds.length === 0 ? [] : await db.select({ id: messages.id, conversationId: messages.conversationId, body: messages.body }).from(messages)
    .innerJoin(conversations, and(eq(conversations.id, messages.conversationId), eq(conversations.agentId, agentId)))
    .where(inArray(messages.id, sourceIds));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const [matchedNote] = await db.select({ id: kbNotes.id, path: kbNotes.path, title: kbNotes.title, body: kbNotes.body })
    .from(kbNotes).where(and(eq(kbNotes.agentId, agentId), eq(kbNotes.path, proposal.path)));
  return {
    id: proposal.id,
    revision: proposal.revision,
    kind: proposal.kind,
    path: proposal.path,
    body: proposal.body,
    confidence: proposal.confidence,
    selected: proposal.selected,
    sources: proposal.sources.map((source) => ({
      ...source,
      excerpt: sourceById.get(source.messageId)?.body?.slice(0, 240) ?? null,
      available: sourceById.get(source.messageId)?.conversationId === source.conversationId,
    })),
    warnings: proposal.warnings,
    matches: matchedNote ? [{
      noteId: matchedNote.id, path: matchedNote.path, title: matchedNote.title,
      exact: matchedNote.body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru') === proposal.body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'),
    }] : [],
    status: proposal.status as KbGenerationProposal['status'],
    draftId: proposal.draftId, noteId: proposal.noteId,
  };
}

export function registerKnowledgeGenerationRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  deps: { model: ModelClient },
): void {
  const owner = requireAgent(db, { role: 'owner' });
  const member = requireAgent(db);
  const base = '/api/agents/:agentId/knowledge/generation';
  const runner = { db, model: deps.model, credentialsKey: credentialsKey(env) };
  const dispatch = (runId: string) => setImmediate(() => void executeGenerationRun(runner, runId).catch(async () => {
    await db.update(kbGenerationRuns).set({ status: 'failed', errorCode: 'unexpected', updatedAt: new Date() }).where(and(
      eq(kbGenerationRuns.id, runId), inArray(kbGenerationRuns.status, ['queued', 'running']),
    )).catch(() => undefined);
    app.log.error({ runId, errorCode: 'unexpected' }, 'knowledge generation failed');
  }));

  app.post(`${base}/preview`, { preHandler: [guard, owner] }, async (req) => {
    const parsed = previewBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Проверьте выбранные диалоги и даты');
    return previewSelection(db, req.agent!.id, parsed.data, req.user!.id);
  });

  app.post(`${base}/runs`, { preHandler: [guard, owner] }, async (req, reply) => {
    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Не удалось начать сбор базы знаний');
    if (req.agent!.openrouterKey === null) throw new ApiError(409, 'Не задан ключ OpenRouter');
    const run = await startGenerationRun(db, req.agent!.id, req.user!.id, parsed.data.previewId, parsed.data.requestKey);
    if (run.status === 'queued') dispatch(run.id);
    return reply.code(202).send(run);
  });

  app.get(`${base}/runs`, { preHandler: [guard, member] }, async (req): Promise<KbGenerationRunPage> => {
    const offset = cursorOffset((req.query as { cursor?: unknown }).cursor);
    const rows = await db.select({ id: kbGenerationRuns.id }).from(kbGenerationRuns)
      .where(eq(kbGenerationRuns.agentId, req.agent!.id))
      .orderBy(desc(kbGenerationRuns.createdAt), desc(kbGenerationRuns.id))
      .limit(PAGE_SIZE + 1).offset(offset);
    const items = await reviewRunSummaries(db, req.agent!.id, rows.slice(0, PAGE_SIZE).map((row) => row.id));
    return { items, nextCursor: after(offset, rows.length) };
  });

  app.get(`${base}/runs/:runId`, { preHandler: [guard, member] }, async (req): Promise<KbGenerationRunDetail> => {
    const { runId } = req.params as { runId: string };
    if (!isUuid(runId)) throw new ApiError(404, 'Запуск не найден');
    if (!(await db.select({ id: kbGenerationRuns.id }).from(kbGenerationRuns).where(and(eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.agentId, req.agent!.id))))[0]) {
      throw new ApiError(404, 'Запуск не найден');
    }
    const query = z.object({
      cursor: z.string().optional(),
      proposalCursor: z.string().optional(),
      draftCursor: z.string().optional(),
      exclusionCursor: z.string().optional(),
      rawFindingCursor: z.string().optional(),
      includeRawFindings: z.enum(['true', 'false']).optional(),
    }).safeParse(req.query);
    if (!query.success) throw new ApiError(400, 'Некорректные параметры запуска');
    const [run] = await reviewRunSummaries(db, req.agent!.id, [runId]);
    const [drafts, exclusions, rawFindings] = await Promise.all([
      generationDraftPage(db, req.agent!.id, runId, cursorOffset(query.data.draftCursor)),
      exclusionPage(db, req.agent!.id, runId, cursorOffset(query.data.exclusionCursor)),
      query.data.includeRawFindings === 'true'
        ? rawFindingPage(db, req.agent!.id, runId, cursorOffset(query.data.rawFindingCursor))
        : Promise.resolve(null),
    ]);
    return {
      run: run!,
      proposals: await proposalPage(db, req.agent!.id, runId, cursorOffset(query.data.proposalCursor ?? query.data.cursor)),
      drafts: drafts.items,
      draftsNextCursor: drafts.nextCursor,
      exclusions: exclusions.items,
      exclusionsNextCursor: exclusions.nextCursor,
      ...(rawFindings ? {
        rawFindings: rawFindings.items,
        rawFindingsNextCursor: rawFindings.nextCursor,
      } : {}),
    };
  });

  app.post(`${base}/runs/:runId/cancel`, { preHandler: [guard, owner] }, async (req) => {
    const { runId } = req.params as { runId: string };
    if (!isUuid(runId)) throw new ApiError(404, 'Запуск не найден');
    return cancelGenerationRun(db, req.agent!.id, runId);
  });

  app.post(`${base}/runs/:runId/retry`, { preHandler: [guard, owner] }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (!isUuid(runId)) throw new ApiError(404, 'Запуск не найден');
    const run = await retryGenerationRun(db, req.agent!.id, runId);
    if (run.status === 'queued') dispatch(run.id);
    return reply.code(202).send(run);
  });

  app.patch(`${base}/proposals/:proposalId`, { preHandler: [guard, owner] }, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    if (!isUuid(proposalId)) throw new ApiError(404, 'Предложение не найдено');
    const parsed = proposalUpdateBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Проверьте изменения предложения');
    await updateGenerationProposal(db, req.agent!.id, proposalId, parsed.data);
    return oneProposal(db, req.agent!.id, proposalId);
  });

  app.post(`${base}/runs/:runId/draft`, { preHandler: [guard, owner] }, async (req) => {
    const { runId } = req.params as { runId: string };
    if (!isUuid(runId)) throw new ApiError(404, 'Запуск не найден');
    const parsed = draftBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Проверьте выбранные предложения');
    return createGenerationDraft(db, req.agent!.id, req.user!.id, runId, parsed.data);
  });
}
