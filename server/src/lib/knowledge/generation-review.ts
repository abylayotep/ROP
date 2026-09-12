import { createHash } from 'node:crypto';
import type { KbGenerationDraftRequest, KbGenerationDraftResponse, KbGenerationProposalUpdateRequest } from '@rakurs/contract';
import { and, asc, eq, inArray, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbDrafts, kbGenerationDrafts, kbGenerationProposals, kbGenerationRuns, kbNotes } from '../../db/schema.js';
import { baseOf, type DraftOp } from '../drafts/ops.js';
import { ApiError, isDuplicate } from '../errors.js';
import { BODY_MAX } from './note.js';
import { GENERATION_LIMITS } from './generation-limits.js';
import { isValidGenerationPath } from './generation-path.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from './generation-types.js';

const fingerprint = (path: string, body: string): string =>
  createHash('sha256')
    .update(`${path.trim().toLocaleLowerCase('ru')}\n${body.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru')}`)
    .digest('hex');

const draftKinds = [
  { kind: 'knowledge', title: 'База знаний из WhatsApp' },
  { kind: 'script', title: 'Скрипт продаж из WhatsApp' },
] as const;

const draftRequestKey = (ids: string[], input: KbGenerationDraftRequest): string =>
  createHash('sha256').update(JSON.stringify({
    proposals: [...ids].sort().map((id) => [id, input.revisions[id] ?? null]),
    updateTargets: Object.entries(input.updateTargets ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  })).digest('hex');

export async function updateGenerationProposal(
  db: Db,
  agentId: string,
  proposalId: string,
  input: KbGenerationProposalUpdateRequest,
): Promise<void> {
  if (input.path !== undefined && !isValidGenerationPath(input.path)) throw new ApiError(400, 'Проверьте название заметки');
  if (input.body !== undefined && (input.body.trim() === '' || input.body.length > BODY_MAX)) throw new ApiError(400, 'Проверьте текст заметки');
  await db.transaction(async (tx) => {
    const [owningRun] = await tx.select({ id: kbGenerationRuns.id })
      .from(kbGenerationProposals)
      .innerJoin(kbGenerationRuns, eq(kbGenerationRuns.id, kbGenerationProposals.runId))
      .where(and(
        eq(kbGenerationProposals.id, proposalId),
        eq(kbGenerationRuns.agentId, agentId),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ))
      .for('update', { of: kbGenerationRuns });
    if (!owningRun) throw new ApiError(409, 'Предложение уже изменилось или обработано');

    const allowedStatuses = input.status === 'pending' ? ['pending', 'rejected'] : ['pending'];
    const [current] = await tx.select({ path: kbGenerationProposals.path, body: kbGenerationProposals.body })
      .from(kbGenerationProposals).where(and(
        eq(kbGenerationProposals.id, proposalId),
        inArray(kbGenerationProposals.status, allowedStatuses),
        eq(kbGenerationProposals.revision, input.revision),
      ));
    if (!current) throw new ApiError(409, 'Предложение уже изменилось или обработано');
    const nextPath = input.path ?? current.path;
    const nextBody = input.body ?? current.body;
    try {
      const [updated] = await tx.update(kbGenerationProposals).set({
        ...(input.path === undefined ? {} : {
          path: input.path,
          kind: input.path.startsWith('Скрипт/') ? 'script' as const : 'knowledge' as const,
        }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.path === undefined && input.body === undefined ? {} : { fingerprint: fingerprint(nextPath, nextBody) }),
        ...(input.selected === undefined ? {} : { selected: input.selected }),
        ...(input.status === undefined ? {} : {
          status: input.status,
          ...(input.status === 'rejected' ? { selected: false } : {}),
        }),
        revision: sql`${kbGenerationProposals.revision} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(kbGenerationProposals.id, proposalId),
        inArray(kbGenerationProposals.status, allowedStatuses),
        eq(kbGenerationProposals.revision, input.revision),
      )).returning({ id: kbGenerationProposals.id });
      if (!updated) throw new ApiError(409, 'Предложение уже изменилось или обработано');
    } catch (error) {
      if (isDuplicate(error)) throw new ApiError(409, 'Такое предложение уже есть в этом запуске');
      throw error;
    }
  });
}

export async function createGenerationDraft(
  db: Db,
  agentId: string,
  userId: string,
  runId: string,
  input: KbGenerationDraftRequest,
): Promise<KbGenerationDraftResponse> {
  const ids = [...new Set(input.proposalIds)];
  if (ids.length < 1 || ids.length > GENERATION_LIMITS.maxDraftProposals || ids.length !== input.proposalIds.length) {
    throw new ApiError(400, 'Выберите от 1 до 20 предложений');
  }
  const requestKey = draftRequestKey(ids, input);
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ id: kbGenerationRuns.id }).from(kbGenerationRuns).where(and(
      eq(kbGenerationRuns.id, runId), eq(kbGenerationRuns.agentId, agentId),
    )).for('update');
    if (!run) throw new ApiError(404, 'Запуск не найден');
    const requested = await tx.select({ proposal: kbGenerationProposals }).from(kbGenerationProposals)
      .innerJoin(kbGenerationRuns, and(eq(kbGenerationRuns.id, kbGenerationProposals.runId), eq(kbGenerationRuns.agentId, agentId)))
      .where(and(
        eq(kbGenerationProposals.runId, runId),
        inArray(kbGenerationProposals.id, ids),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ))
      .for('update');
    if (requested.length !== ids.length) throw new ApiError(404, 'Предложение не найдено');
    const requestedRows = requested.map((row) => row.proposal);
    const existingDraftIds = [...new Set(requestedRows.map((row) => row.draftId).filter((id): id is string => id !== null))];
    if (existingDraftIds.length > 0 && requestedRows.every((row) => row.status === 'drafted' && row.draftId !== null)) {
      const orderedDraftIds = draftKinds.flatMap(({ kind }) => {
        const kindDraftIds = [...new Set(requestedRows.filter((row) => row.kind === kind).map((row) => row.draftId!))];
        return kindDraftIds.length === 1 ? kindDraftIds : [];
      });
      const hasOneDraftPerKind = orderedDraftIds.length === existingDraftIds.length &&
        existingDraftIds.every((draftId) => orderedDraftIds.includes(draftId));
      const links = await tx.select({ draftId: kbGenerationDrafts.draftId, requestKey: kbGenerationDrafts.requestKey })
        .from(kbGenerationDrafts).where(and(
          eq(kbGenerationDrafts.runId, runId),
          inArray(kbGenerationDrafts.draftId, existingDraftIds),
        ));
      const hasExactRequestIdentity = links.length === existingDraftIds.length &&
        links.every((link) => link.requestKey === requestKey);
      const isLegacySingleDraft = existingDraftIds.length === 1 && links.length === 1 && links[0]!.requestKey === null;
      const drafts = await tx.select({ id: kbDrafts.id, ops: kbDrafts.ops }).from(kbDrafts).where(and(
        eq(kbDrafts.agentId, agentId),
        inArray(kbDrafts.id, existingDraftIds),
      ));
      const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
      const allDrafted = await tx.select({
        id: kbGenerationProposals.id,
        revision: kbGenerationProposals.revision,
        draftId: kbGenerationProposals.draftId,
        draftOpIndex: kbGenerationProposals.draftOpIndex,
      })
        .from(kbGenerationProposals).where(and(
          eq(kbGenerationProposals.runId, runId),
          inArray(kbGenerationProposals.draftId, existingDraftIds),
          notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
        ));
      const sameIds = allDrafted.length === ids.length && allDrafted.every((row) => ids.includes(row.id));
      const sameRevisions = allDrafted.every((row) => input.revisions[row.id] === row.revision - 1);
      const sameTargets = allDrafted.every((row) => {
        const op = row.draftOpIndex === null || !row.draftId
          ? undefined
          : draftById.get(row.draftId)?.ops[row.draftOpIndex];
        const target = op?.op === 'note_update' ? op.noteId : undefined;
        return input.updateTargets?.[row.id] === target;
      }) && Object.keys(input.updateTargets ?? {}).length === allDrafted.filter((row) => {
        const op = row.draftOpIndex === null || !row.draftId
          ? undefined
          : draftById.get(row.draftId)?.ops[row.draftOpIndex];
        return op?.op === 'note_update';
      }).length;
      if ((isLegacySingleDraft || (hasExactRequestIdentity && hasOneDraftPerKind)) &&
          drafts.length === existingDraftIds.length && sameIds && sameRevisions && sameTargets) {
        const replayDraftIds = isLegacySingleDraft ? existingDraftIds : orderedDraftIds;
        return { draftId: replayDraftIds[0]!, draftIds: replayDraftIds };
      }
      throw new ApiError(409, 'Эти предложения уже входят в другой запрос черновика');
    }

    const selected = await tx.select({ proposal: kbGenerationProposals }).from(kbGenerationProposals)
      .where(and(
        eq(kbGenerationProposals.runId, runId),
        eq(kbGenerationProposals.status, 'pending'),
        eq(kbGenerationProposals.selected, true),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ))
      .orderBy(asc(kbGenerationProposals.createdAt), asc(kbGenerationProposals.id))
      .for('update');
    const rows = selected.map((row) => row.proposal);
    const selectedIds = rows.map((row) => row.id);
    if (selectedIds.length !== ids.length || selectedIds.some((id) => !ids.includes(id))) {
      throw new ApiError(409, 'Выбранные предложения уже изменились');
    }
    if (rows.some((row) => row.status !== 'pending' || row.draftId !== null)) throw new ApiError(409, 'Одно из предложений уже обработано');
    if (rows.some((row) => input.revisions[row.id] !== row.revision)) throw new ApiError(409, 'Одно из предложений уже изменилось');

    const targetIds = Object.values(input.updateTargets ?? {});
    if (new Set(targetIds).size !== targetIds.length) throw new ApiError(400, 'Одну заметку нельзя обновить двумя предложениями');
    const targets = targetIds.length === 0 ? [] : await tx.select({ id: kbNotes.id }).from(kbNotes).where(and(
      eq(kbNotes.agentId, agentId), inArray(kbNotes.id, targetIds),
    ));
    if (targets.length !== new Set(targetIds).size) throw new ApiError(404, 'Заметка для обновления не найдена');
    const draftIds: string[] = [];
    for (const category of draftKinds) {
      const categoryRows = rows.filter((proposal) => proposal.kind === category.kind);
      if (categoryRows.length === 0) continue;
      const ops: DraftOp[] = categoryRows.map((proposal) => {
        const noteId = input.updateTargets?.[proposal.id];
        return noteId ? { op: 'note_update', noteId, body: proposal.body } : { op: 'note_create', path: proposal.path, body: proposal.body };
      });
      const base = await baseOf(tx as unknown as Db, agentId, ops);
      const [draft] = await tx.insert(kbDrafts).values({
        agentId,
        title: `${category.title} · ${categoryRows.length}`,
        origin: 'manual',
        ops,
        base,
        createdBy: userId,
      }).returning({ id: kbDrafts.id });
      draftIds.push(draft!.id);
      await tx.insert(kbGenerationDrafts).values({ runId, draftId: draft!.id, requestKey });
      for (let index = 0; index < categoryRows.length; index += 1) {
        await tx.update(kbGenerationProposals).set({
          status: 'drafted',
          selected: false,
          draftId: draft!.id,
          draftOpIndex: index,
          revision: sql`${kbGenerationProposals.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(kbGenerationProposals.id, categoryRows[index]!.id),
          notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
        ));
      }
    }
    return { draftId: draftIds[0]!, draftIds };
  });
}
