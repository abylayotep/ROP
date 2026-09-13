/**
 * The case set a draft is proven against: kept by hand, pulled out of a real dialog, or
 * suggested by the model — never grown on its own.
 *
 * ## `from-dialog` copies the customer's side only
 *
 * `messages` (`db/schema.ts`'s own comment on `test_cases`) is what the run route replays
 * against a draft's ops — the agent's own replies are the thing being tested, so keeping them
 * here would be keeping the answer inside the question. `POST …/from-dialog` reads only the
 * conversation's inbound messages, oldest of the newest ten it keeps first, and titles the case
 * by that first one — the same `clampTitle` a draft's own list entry uses (`api/drafts.ts`).
 *
 * ## `suggest-cases` saves nothing
 *
 * `lib/drafts/suggest.ts` asks the model for five to ten customer questions aimed at what a
 * draft's ops actually change, and this route hands the list straight back — no `test_cases`
 * row is written. A set that grows by itself is a set nobody trusts; the owner decides what of
 * the model's list, if any, is worth keeping by posting it back through the ordinary create
 * route above.
 *
 * ## A disabled case stays in the set
 *
 * `PATCH …/:caseId` can turn `enabled` off, and the run route (`api/drafts.ts`) already filters
 * a disabled case out before it ever costs anything. Nothing here deletes one for being
 * disabled — that would throw away the very baseline a re-enabled case would want back.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { conversations, kbDrafts, messages, testCases, testResults, testRuns } from '../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import type { ModelClient } from '../lib/ai/openrouter.js';
import { ModelError } from '../lib/ai/openrouter.js';
import { keyAad } from '../lib/ai/turn.js';
import { suggestCases, SuggestParseError } from '../lib/drafts/suggest.js';
import { ApiError } from '../lib/errors.js';
import { clampTitle } from '../lib/knowledge/split.js';
import { credentialsKey, decryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';
import type { CoachSourceSnapshot } from '@rakurs/contract';

/** A case's own conversation can run long; ten replayed messages is already two model calls'
 * worth of context inside one case, and `from-dialog` keeps to the same bound for the same
 * reason. */
const MAX_MESSAGES = 10;
const MESSAGE_MAX = 4000;
const TITLE_MAX = 200;
const EXPECTATION_MAX = 500;

export function correctionCaseFromSnapshot(snapshot: CoachSourceSnapshot, note: string) {
  const messages = snapshot.transcript.split(/\n(?=(?:client|ai): )/)
    .filter((line) => line.startsWith('client: '))
    .map((line) => clampTitle(line.slice('client: '.length).trim(), MESSAGE_MAX))
    .filter(Boolean).slice(-MAX_MESSAGES);
  if (messages.length === 0) throw new ApiError(409, 'В сохранённом ответе нет сообщения клиента для проверки');
  return { title: clampTitle(messages[0]!, TITLE_MAX), messages,
    expectation: clampTitle(note.trim(), EXPECTATION_MAX) };
}

const createCaseBody = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  messages: z.array(z.string().trim().min(1).max(MESSAGE_MAX)).min(1).max(MAX_MESSAGES),
  expectation: z.string().trim().min(1).max(EXPECTATION_MAX).nullable().optional(),
});

const patchCaseBody = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  messages: z.array(z.string().trim().min(1).max(MESSAGE_MAX)).min(1).max(MAX_MESSAGES).optional(),
  expectation: z.string().trim().min(1).max(EXPECTATION_MAX).nullable().optional(),
  enabled: z.boolean().optional(),
});

const fromDialogBody = z.object({
  conversationId: z.string().trim().min(1),
});

const toCase = (row: typeof testCases.$inferSelect) => ({
  id: row.id,
  title: row.title,
  messages: row.messages,
  expectation: row.expectation,
  origin: row.origin as 'manual' | 'dialog' | 'generated' | 'correction',
  conversationId: row.conversationId,
  requiredDraftId: row.requiredDraftId,
  enabled: row.enabled,
  updatedAt: row.updatedAt.toISOString(),
});

export interface TestCaseDeps {
  model: ModelClient;
}

export function registerTestCaseRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  deps: TestCaseDeps,
): void {
  // A test case is part of proving a change, the same standing a draft itself has — every
  // route below, the read included, is owner-only.
  const ownerOnly = requireAgent(db, { role: 'owner' });

  /** One agent's case, or 404 — never another agent's, and never a bare 500 on a malformed id. */
  async function loadCase(agentId: string, caseId: string): Promise<typeof testCases.$inferSelect> {
    if (!isUuid(caseId)) throw new ApiError(404, 'Случай не найден');
    const [row] = await db
      .select()
      .from(testCases)
      .where(and(eq(testCases.id, caseId), eq(testCases.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Случай не найден');
    return row;
  }

  app.get(
    '/api/agents/:agentId/test-cases',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const rows = await db
        .select()
        .from(testCases)
        .where(eq(testCases.agentId, req.agent!.id))
        .orderBy(desc(testCases.createdAt));
      return rows.map(toCase);
    },
  );

  app.post(
    '/api/agents/:agentId/test-cases',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const parsed = createCaseBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать случай');

      const [row] = await db
        .insert(testCases)
        .values({
          agentId: req.agent!.id,
          title: parsed.data.title,
          messages: parsed.data.messages,
          expectation: parsed.data.expectation ?? null,
          origin: 'manual',
        })
        .returning();

      return toCase(row!);
    },
  );

  app.patch(
    '/api/agents/:agentId/test-cases/:caseId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const { caseId } = req.params as { caseId: string };
      const existing = await loadCase(agentId, caseId);
      if (existing.requiredDraftId) throw new ApiError(409, 'Обязательный случай исправления нельзя изменить');

      const parsed = patchCaseBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать случай');
      const { title, messages: msgs, expectation, enabled } = parsed.data;

      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(testCases)
          .set({
            ...(title === undefined ? {} : { title }),
            ...(msgs === undefined ? {} : { messages: msgs }),
            ...(expectation === undefined ? {} : { expectation }),
            ...(enabled === undefined ? {} : { enabled }),
            updatedAt: sql`now()`,
          })
          .where(and(eq(testCases.id, caseId), eq(testCases.agentId, agentId)))
          .returning();

        // `baselineResults` (`lib/drafts/baseline.ts`) keys «было» on the case, the agent's
        // `config_version` and its model — it knows nothing about `test_cases.updated_at`, so
        // a changed question would otherwise still pair against the *old* question's «было»:
        // a run would compare the new answer against an answer to something nobody is asking
        // any more, and pay a model to write a verdict about the mismatch. Deleting this
        // case's own baseline rows here — the ones written by a run with no draft at all
        // (`draft_id is null`) — is what makes the next run pay for a fresh one instead of
        // reusing a stale one; a draft's own «стало» rows need no such cleanup, since they are
        // never reused as anyone's baseline to begin with.
        if (msgs !== undefined) {
          const baselineRuns = await tx
            .select({ id: testRuns.id })
            .from(testRuns)
            .where(and(eq(testRuns.agentId, agentId), isNull(testRuns.draftId)));
          if (baselineRuns.length > 0) {
            await tx
              .delete(testResults)
              .where(
                and(
                  eq(testResults.caseId, caseId),
                  inArray(
                    testResults.runId,
                    baselineRuns.map((run) => run.id),
                  ),
                ),
              );
          }
        }

        return updated!;
      });

      return toCase(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/test-cases/:caseId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const { caseId } = req.params as { caseId: string };
      const existing = await loadCase(agentId, caseId);
      if (existing.requiredDraftId) throw new ApiError(409, 'Обязательный случай исправления нельзя удалить');
      await db.delete(testCases).where(and(eq(testCases.id, caseId), eq(testCases.agentId, agentId)));
      return { ok: true };
    },
  );

  app.post(
    '/api/agents/:agentId/test-cases/from-dialog',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const parsed = fromDialogBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать диалог');
      const { conversationId } = parsed.data;

      // A malformed id is exactly as absent as one that does not exist — comparing it
      // against a uuid column would make Postgres raise instead of this route answering 404.
      if (!isUuid(conversationId)) throw new ApiError(404, 'Диалог не найден');
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));
      if (!conversation) throw new ApiError(404, 'Диалог не найден');

      // Inbound only — the agent's own side is what a run replaces and compares, not what a
      // case replays. Oldest first, so the slice below keeps the newest ten in the order the
      // customer actually said them, and the run route reads `messages` the same way.
      const inbound = await db
        .select({ body: messages.body })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'in')))
        .orderBy(messages.sentAt);

      const bodies = inbound.map((row) => row.body).filter((body): body is string => body !== null && body !== '');
      // A real customer message carries no length limit of its own, but `patchCaseBody` above
      // caps every message at `MESSAGE_MAX` — without the same clamp here, a long enough line
      // would make it into a case only `POST` could write, and `PATCH` could never save back
      // even unchanged. `clampTitle` is the same truncate-with-ellipsis this file already uses
      // for the case's own title, just at a longer bound.
      const selected = bodies.slice(-MAX_MESSAGES).map((body) => clampTitle(body, MESSAGE_MAX));
      if (selected.length === 0) {
        throw new ApiError(400, 'В этом диалоге нет сообщений клиента');
      }

      const [row] = await db
        .insert(testCases)
        .values({
          agentId,
          title: clampTitle(selected[0]!, TITLE_MAX),
          messages: selected,
          origin: 'dialog',
          conversationId,
        })
        .returning();

      return toCase(row!);
    },
  );

  app.post(
    '/api/agents/:agentId/drafts/:draftId/suggest-cases',
    {
      preHandler: [guard, ownerOnly],
      // The same balance a sandbox turn or a coaching message spends, under the same bound.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const agentId = req.agent!.id;
      const { draftId } = req.params as { draftId: string };
      if (!isUuid(draftId)) throw new ApiError(404, 'Черновик не найден');
      const [draft] = await db
        .select({ ops: kbDrafts.ops })
        .from(kbDrafts)
        .where(and(eq(kbDrafts.id, draftId), eq(kbDrafts.agentId, agentId)));
      if (!draft) throw new ApiError(404, 'Черновик не найден');

      if (req.agent!.openrouterKey === null) {
        throw new ApiError(409, 'Не задан ключ OpenRouter');
      }

      // Taken and released the same way the coach's own single call does — see
      // `api/coach.ts` — so this one-off suggestion competes for the same shared slot as
      // every other call that actually spends the owner's balance, rather than bypassing it.
      if (!tryTakeTurnSlot()) {
        throw new ApiError(429, 'Модель занята. Попробуйте через несколько секунд.');
      }

      try {
        const key = decryptSecret(req.agent!.openrouterKey, credentialsKey(env), keyAad(agentId));
        const { cases } = await suggestCases(
          { model: deps.model, key, modelId: req.agent!.model, temperature: req.agent!.temperature },
          draft.ops,
        );
        return { cases };
      } catch (error) {
        if (error instanceof SuggestParseError) {
          throw new ApiError(502, 'Не удалось разобрать предложения модели');
        }
        if (error instanceof ModelError) {
          throw new ApiError(502, error.message);
        }
        throw error;
      } finally {
        releaseTurnSlot();
      }
    },
  );
}
