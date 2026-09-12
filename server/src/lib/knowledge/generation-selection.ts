import { createHash } from 'node:crypto';
import type { KbGenerationPreview, KbGenerationSelection } from '@rakurs/contract';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  agents,
  conversations,
  kbGenerationPreviews,
  messages,
} from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { GENERATION_LIMITS } from './generation-limits.js';
import { redactGenerationText } from './generation-redact.js';
import type {
  GenerationBatchManifest,
  GenerationManifest,
  GenerationManifestEntry,
  GenerationStoredCounts,
} from './generation-types.js';

const SUPPORTED_KINDS = new Set(['text', 'image', 'video', 'document']);
const SELLER_AUTHORS = new Set(['phone', 'operator']);

const RAW_SCAN_LIMIT = 20_000;

export interface GenerationHashInput {
  id: string;
  conversationId: string;
  author: string;
  kind: string;
  body: string;
  sentAt: Date;
}

export const generationContentHash = (message: GenerationHashInput): string =>
  createHash('sha256').update(JSON.stringify({
    id: message.id,
    conversationId: message.conversationId,
    author: message.author,
    kind: message.kind,
    body: message.body,
    sentAt: message.sentAt.toISOString(),
  }), 'utf8').digest('hex');

function parseSelection(selection: KbGenerationSelection): { from: Date; to: Date } {
  const from = new Date(selection.from);
  const to = new Date(selection.to);
  if (
    selection.conversationIds.length === 0 ||
    selection.conversationIds.length > GENERATION_LIMITS.maxConversations ||
    new Set(selection.conversationIds).size !== selection.conversationIds.length ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to
  ) {
    throw new ApiError(400, 'Проверьте выбранные диалоги и даты');
  }
  return { from, to };
}

function emptyCounts(selectedConversations: number): GenerationStoredCounts {
  return {
    selectedConversations,
    selectedMessages: 0,
    eligibleMessages: 0,
    eligibleCharacters: 0,
    skippedAiOrSystem: 0,
    skippedUnsupported: 0,
    skippedEmpty: 0,
    skippedSensitive: 0,
    skippedOversize: 0,
    skippedNoSeller: 0,
  };
}

interface EligibleMessage extends GenerationManifestEntry {
  author: string;
  redactedBody: string;
}

function makeBatches(rows: EligibleMessage[], counts: GenerationStoredCounts): GenerationBatchManifest[] {
  const batches: GenerationBatchManifest[] = [];
  const byConversation = new Map<string, EligibleMessage[]>();
  for (const row of rows) {
    const list = byConversation.get(row.conversationId) ?? [];
    list.push(row);
    byConversation.set(row.conversationId, list);
  }

  for (const [conversationId, conversationRows] of byConversation) {
    let current: EligibleMessage[] = [];
    let characters = 0;
    const flush = () => {
      if (current.length === 0) return;
      if (current.some((message) => SELLER_AUTHORS.has(message.author))) {
        batches.push({
          ordinal: batches.length,
          conversationId,
          messages: current.map(({ messageId, conversationId: ownerId, contentHash, ordinal }) => ({
            messageId,
            conversationId: ownerId,
            contentHash,
            ordinal,
          })),
          characterCount: characters,
        });
      } else {
        counts.skippedNoSeller += current.length;
      }
      current = [];
      characters = 0;
    };

    for (const row of conversationRows) {
      if (
        current.length >= GENERATION_LIMITS.maxBatchMessages ||
        characters + row.redactedBody.length > GENERATION_LIMITS.maxBatchCharacters
      ) {
        flush();
      }
      current.push(row);
      characters += row.redactedBody.length;
    }
    flush();
  }
  return batches;
}

export interface LoadedGenerationPreview {
  id: string;
  agentId: string;
  userId: string | null;
  selection: KbGenerationSelection;
  manifest: GenerationManifest;
  counts: GenerationStoredCounts;
  modelId: string;
  expiresAt: Date;
}

/** Creates a persisted, no-model-call preview of the exact bounded source manifest. */
export async function previewSelection(
  db: Db,
  agentId: string,
  selection: KbGenerationSelection,
  userId?: string,
): Promise<KbGenerationPreview> {
  const { from, to } = parseSelection(selection);
  const own = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), inArray(conversations.id, selection.conversationIds)));
  if (own.length !== selection.conversationIds.length) {
    throw new ApiError(404, 'Один из выбранных диалогов недоступен');
  }

  await db.delete(kbGenerationPreviews).where(lt(kbGenerationPreviews.expiresAt, new Date()));
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      author: messages.author,
      kind: messages.kind,
      body: sql<string | null>`case when length(${messages.body}) <= ${GENERATION_LIMITS.maxBatchCharacters + 1} then ${messages.body} else null end`,
      bodyLength: sql<number | null>`length(${messages.body})`,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(
      eq(conversations.agentId, agentId),
      inArray(messages.conversationId, selection.conversationIds),
      gte(messages.sentAt, from),
      lt(messages.sentAt, to),
    ))
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(RAW_SCAN_LIMIT + 1);

  if (rows.length > RAW_SCAN_LIMIT) {
    throw new ApiError(400, 'В выбранном периоде слишком много сообщений. Уменьшите период.');
  }

  const order = new Map(selection.conversationIds.map((id, index) => [id, index]));
  rows.sort((a, b) =>
    (order.get(a.conversationId) ?? 0) - (order.get(b.conversationId) ?? 0) ||
    a.sentAt.getTime() - b.sentAt.getTime() ||
    a.id.localeCompare(b.id));

  const counts = emptyCounts(selection.conversationIds.length);
  counts.selectedMessages = rows.length;
  const eligible: EligibleMessage[] = [];
  for (const row of rows) {
    if (row.author === 'ai' || row.author === 'system') {
      counts.skippedAiOrSystem += 1;
      continue;
    }
    if (!SUPPORTED_KINDS.has(row.kind)) {
      counts.skippedUnsupported += 1;
      continue;
    }
    if ((row.bodyLength ?? 0) > GENERATION_LIMITS.maxBatchCharacters) {
      counts.skippedOversize += 1;
      continue;
    }
    if (row.body === null || row.body.trim() === '') {
      counts.skippedEmpty += 1;
      continue;
    }
    const redactedBody = redactGenerationText(row.body);
    if (redactedBody === null) {
      counts.skippedSensitive += 1;
      continue;
    }
    eligible.push({
      messageId: row.id,
      conversationId: row.conversationId,
      contentHash: generationContentHash({ ...row, body: row.body }),
      ordinal: eligible.length,
      author: row.author,
      redactedBody,
    });
  }

  const batches = makeBatches(eligible, counts);
  const keptIds = new Set(batches.flatMap((batch) => batch.messages.map((message) => message.messageId)));
  const manifestMessages = eligible
    .filter((message) => keptIds.has(message.messageId))
    .map(({ messageId, conversationId, contentHash, ordinal }) => ({ messageId, conversationId, contentHash, ordinal }));
  counts.eligibleMessages = manifestMessages.length;
  counts.eligibleCharacters = eligible
    .filter((message) => keptIds.has(message.messageId))
    .reduce((sum, message) => sum + message.redactedBody.length, 0);

  if (
    counts.eligibleMessages > GENERATION_LIMITS.maxEligibleMessages ||
    counts.eligibleCharacters > GENERATION_LIMITS.maxInputCharacters ||
    batches.length > GENERATION_LIMITS.maxBatches
  ) {
    throw new ApiError(400, 'Выбор слишком большой. Уменьшите число диалогов или период.');
  }

  const manifest: GenerationManifest = { messages: manifestMessages, batches };
  const [agent] = await db.select({ model: agents.model }).from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new ApiError(404, 'Агент не найден');
  const modelId = agent.model;
  const expiresAt = new Date(Date.now() + GENERATION_LIMITS.previewTtlMs);
  const [stored] = await db.insert(kbGenerationPreviews).values({
    agentId,
    userId,
    selection,
    manifest,
    counts,
    modelId,
    expiresAt,
  }).returning({ id: kbGenerationPreviews.id });

  return {
    previewId: stored!.id,
    expiresAt: expiresAt.toISOString(),
    counts,
    batchCount: batches.length,
    modelId,
    maxCalls: batches.length,
    maxOutputTokens: GENERATION_LIMITS.maxOutputTokens,
    truncated: false,
  };
}

/** Resolves a preview only while every frozen source still belongs to the agent and matches. */
export async function loadPreview(db: Db, agentId: string, previewId: string): Promise<LoadedGenerationPreview> {
  const [preview] = await db.select().from(kbGenerationPreviews).where(and(
    eq(kbGenerationPreviews.id, previewId), eq(kbGenerationPreviews.agentId, agentId),
  ));
  if (!preview) throw new ApiError(404, 'Предпросмотр не найден');
  if (preview.expiresAt.getTime() <= Date.now()) throw new ApiError(409, 'Предпросмотр устарел. Обновите его.');

  const ids = preview.manifest.messages.map((message) => message.messageId);
  const current = ids.length === 0 ? [] : await db
    .select({
      id: messages.id,
      body: messages.body,
      conversationId: messages.conversationId,
      author: messages.author,
      kind: messages.kind,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.agentId, agentId), inArray(messages.id, ids)));
  const byId = new Map(current.map((row) => [row.id, row]));
  const changed = preview.manifest.messages.some((entry) => {
    const row = byId.get(entry.messageId);
    return !row || row.conversationId !== entry.conversationId || row.body === null || generationContentHash({ ...row, body: row.body }) !== entry.contentHash;
  });
  if (changed) throw new ApiError(409, 'История изменилась. Обновите предпросмотр.');
  return preview;
}
