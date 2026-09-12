/**
 * What the owner sets about the agent, what they may pick, and the sandbox.
 *
 * The settings follow the path `whatsapp-numbers.ts` settled on for a WhatsApp token: the
 * key goes in and never comes out, and what a reader is told is whether one is stored.
 */
import type {
  AiModel,
  AiSettings,
  AiTestContact,
  AiTurn,
  AiUsage,
  AiUsageModel,
  AiUsageTotals,
} from '@rakurs/contract';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  agentResponseModeChanges,
  agents,
  aiReplies,
  contacts,
  conversations,
  kbChunks,
  leadFields,
  stages,
  whatsappNumbers,
} from '../db/schema.js';
import { withAgentAutomationLock } from '../lib/automation/execution.js';
import { releaseTurnSlot, sandboxTurns, SANDBOX_TURNS, tryTakeTurnSlot } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import { MODELS } from '../lib/ai/openrouter.js';
import { keyAad } from '../lib/ai/turn.js';
import { replayCase, type AiDeps } from '../lib/drafts/replay.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import { periodQuery, periodSince } from '../lib/period.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

// `AiDeps` now lives in `lib/drafts/replay.ts`, beside `replayCase` — the function that
// actually spends it — and re-exported here so nothing that already imports it from this file
// has to change.
export type { AiDeps };

/** What a customer may say to the sandbox. A WhatsApp message is far shorter than this. */
const SANDBOX_LIMIT = 4_000;

// `SANDBOX_TURNS` and `sandboxTurns` now live in `db/turn-cap.ts`, shared with the coach —
// re-exported here so nothing that already imports them from this file has to change. See
// that file's comment for why the cap and the in-flight counter behind it are shared rather
// than each feature keeping its own.
export { SANDBOX_TURNS, sandboxTurns };

const settings = z
  .object({
    aiEnabled: z.boolean().optional(),
    responseMode: z.enum(['off', 'test', 'live']).optional(),
    testContactId: z.uuid().nullable().optional(),
    model: z.string().trim().optional(),
    temperature: z.number().min(0).max(2).optional(),
    replyLanguage: z.string().trim().min(1).max(40).optional(),
    // Optional and nullable are different things here: absent leaves the stored key alone,
    // and an explicit null clears it.
    openrouterKey: z.string().trim().min(1).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

/**
 * Everything a usage answer counts, in one aggregate — the whole period, or one model.
 *
 * Counted and summed in Postgres rather than over rows read into Node: a month of turns is
 * a row per reply, and none of them is worth sending over the wire to be added up here.
 *
 * The two token sums are cast to `bigint` and read back as text, then parsed. `::int` would
 * be enough for any real agent and would raise `integer out of range` for the one that is
 * not — turning a busy month into a 500 on the screen that exists to explain the bill.
 *
 * The cost is a string the whole way, exactly as `board.ts` sums an order total: `numeric`
 * added in Postgres and read back with `::text`. A turn costs fractions of a cent, and a
 * float would round them away before anyone saw them. The sum is cast wider than the column
 * — `cost` is numeric(12,8), so ten thousand of the most expensive turns imaginable still
 * fit inside numeric(16,8) rather than raising `numeric field overflow` on the whole route.
 */
const usageColumns = {
  turns: sql<number>`count(*)::int`,
  sent: sql<number>`(count(*) filter (where ${aiReplies.outcome} = 'sent'))::int`,
  handoff: sql<number>`(count(*) filter (where ${aiReplies.outcome} = 'handoff'))::int`,
  failed: sql<number>`(count(*) filter (where ${aiReplies.outcome} = 'failed'))::int`,
  promptTokens: sql<string>`coalesce(sum(${aiReplies.promptTokens}), 0)::bigint::text`,
  completionTokens: sql<string>`coalesce(sum(${aiReplies.completionTokens}), 0)::bigint::text`,
  cost: sql<string>`coalesce(sum(${aiReplies.cost}), 0)::numeric(16,8)::text`,
};

/** What `usageColumns` selects, before the two token sums stop being text. */
interface UsageRow {
  turns: number;
  sent: number;
  handoff: number;
  failed: number;
  promptTokens: string;
  completionTokens: string;
  cost: string;
}

const toTotals = (row: UsageRow): AiUsageTotals => ({
  turns: row.turns,
  sent: row.sent,
  handoff: row.handoff,
  failed: row.failed,
  // Text out of Postgres, a number in the contract: a token count is a count, not an
  // amount, and it is far below the point where a double stops being exact.
  promptTokens: Number(row.promptTokens),
  completionTokens: Number(row.completionTokens),
  cost: row.cost,
});

/** The key is never part of this. Only whether there is one. */
const toContact = (row: typeof contacts.$inferSelect): AiTestContact => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
});

const toApi = (
  row: typeof agents.$inferSelect,
  testContact: typeof contacts.$inferSelect | undefined,
): AiSettings => ({
  aiEnabled: row.aiEnabled,
  responseMode: row.responseMode,
  testContact: testContact ? toContact(testContact) : null,
  model: row.model,
  temperature: Number(row.temperature),
  replyLanguage: row.replyLanguage,
  keySet: row.openrouterKey !== null,
});

export function registerAiRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  deps: AiDeps,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  app.get(
    '/api/agents/:agentId/ai',
    { preHandler: [guard, anyMember] },
    async (req): Promise<AiSettings> => {
      const [selected] = req.agent!.testContactId
        ? await db
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.id, req.agent!.testContactId),
                eq(contacts.agentId, req.agent!.id),
              ),
            )
        : [];
      return toApi(req.agent!, selected);
    },
  );

  app.get(
    '/api/agents/:agentId/ai/test-contacts',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<AiTestContact[]> => {
      const rows = await db
        .select()
        .from(contacts)
        .where(eq(contacts.agentId, req.agent!.id))
        .orderBy(asc(contacts.name), asc(contacts.phone));
      return rows.map(toContact);
    },
  );

  app.patch(
    '/api/agents/:agentId/ai',
    // Owner only: the agent's character now lives in `agent_rules`, behind its own routes,
    // but the model, the temperature and the key are still set here — and the key is what
    // the business pays with.
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<AiSettings> => {
      const parsed = settings.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки агента');
      const {
        aiEnabled,
        responseMode,
        testContactId,
        model,
        temperature,
        replyLanguage,
        openrouterKey,
      } = parsed.data;

      // A list, not free text: an id OpenRouter does not know would be learned about from a
      // customer's silence.
      if (model !== undefined && !MODELS.some((known) => known.id === model)) {
        throw new ApiError(400, 'Неизвестная модель');
      }

      const changes: Partial<typeof agents.$inferInsert> = {};
      const requestedMode =
        responseMode ?? (aiEnabled === undefined ? undefined : aiEnabled ? 'live' : 'off');
      if (requestedMode !== undefined) {
        changes.responseMode = requestedMode;
        // Kept in sync while the legacy boolean remains in the turn pipeline. The explicit
        // mode wins when both fields arrive; an older client that sends only the boolean is
        // mapped back into the same source of truth instead of creating contradictory state.
        changes.aiEnabled = requestedMode !== 'off';
      }
      if (testContactId !== undefined) changes.testContactId = testContactId;
      if (model !== undefined) changes.model = model;
      // The column is numeric(3,2) and hands back a string; two decimals is all it keeps.
      if (temperature !== undefined) changes.temperature = temperature.toFixed(2);
      if (replyLanguage !== undefined) changes.replyLanguage = replyLanguage;
      if (openrouterKey !== undefined) {
        changes.openrouterKey =
          openrouterKey === null
            ? null
            : // Sealed with the agent's id, exactly as `runTurn` opens it: a row copied into
              // another agent decrypts to nothing rather than to a working key.
              encryptSecret(openrouterKey, credentialsKey(env), keyAad(req.agent!.id));
      }

      // `temperature` and `replyLanguage` change what the agent would say for the same
      // input — the former through sampling, the latter through `rulesSection` in
      // `prompt.ts` — so either one has to bump `configVersion` the same way a knowledge
      // note or a rule does, or a baseline recorded before the change would look reusable
      // after it. `model` does not: `baselineResults` already filters on it directly, and
      // `aiEnabled`/`openrouterKey` change whether the agent answers at all, not what it
      // would say. Bumped inside the same transaction as the write it describes, so a
      // version can never land ahead of — or behind — the row it is meant to describe.
      const bumps = temperature !== undefined || replyLanguage !== undefined;
      const result = await withAgentAutomationLock(db, req.agent!.id, async (tx) => {
        // The same lock is held by every automated final effect. Whichever side acquires it
        // first finishes first: once this PATCH returns, no effect authorized under the old
        // response scope can still begin or complete behind it.
        // Every partial PATCH derives its omitted fields from the same locked row it updates.
        // Without this lock, two valid requests can both validate stale state and commit the
        // invalid combination `responseMode = 'test', testContactId = null`.
        const [current] = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, req.agent!.id))
          .for('update');
        if (!current) throw new ApiError(404, 'Агент не найден');

        // An agent left on with no key skips every message in silence, and the only place that
        // silence shows is the reply log. This validation also uses the locked current row, so
        // a concurrent key update cannot make it approve a stale combination.
        const keyAfter =
          openrouterKey !== undefined ? changes.openrouterKey : current.openrouterKey;
        const enabledAfter = changes.aiEnabled ?? current.aiEnabled;
        if (enabledAfter && !keyAfter) {
          throw new ApiError(
            400,
            openrouterKey === null
              ? 'Сначала выключите агента: без ключа он не сможет отвечать'
              : 'Сначала добавьте ключ OpenRouter',
          );
        }

        const effectiveMode = requestedMode ?? current.responseMode;
        const effectiveContactId =
          testContactId !== undefined ? testContactId : current.testContactId;
        const [selected] = effectiveContactId
          ? await tx
              .select()
              .from(contacts)
              .where(
                and(
                  eq(contacts.id, effectiveContactId),
                  eq(contacts.agentId, current.id),
                ),
              )
              .for('share')
          : [];

        if (testContactId !== undefined && effectiveContactId && !selected) {
          throw new ApiError(400, 'Выберите клиента этого агента');
        }
        if (effectiveMode === 'test' && !selected) {
          throw new ApiError(400, 'Выберите клиента для тестового режима');
        }

        const [updated] = await tx
          .update(agents)
          .set(changes)
          .where(eq(agents.id, current.id))
          .returning();
        if (
          updated
          && (updated.responseMode !== current.responseMode
            || updated.testContactId !== current.testContactId)
        ) {
          await tx.insert(agentResponseModeChanges).values({
            agentId: current.id,
            actorUserId: req.user!.id,
            oldResponseMode: current.responseMode,
            oldTestContactId: current.testContactId,
            newResponseMode: updated.responseMode,
            newTestContactId: updated.testContactId,
          });
        }
        if (bumps) await bumpConfigVersion(tx as unknown as Db, current.id);
        return { updated: updated!, selected };
      });
      return toApi(result.updated, result.selected);
    },
  );

  // No agent in the path: the list is the same for everyone and says nothing about anybody's
  // business. A session is still required — it is not the public's list.
  app.get('/api/ai/models', { preHandler: [guard] }, async (): Promise<AiModel[]> =>
    MODELS.map((model) => ({ ...model })),
  );

  /**
   * Во что обошлись ответы агента за период, и во что — каждая модель отдельно.
   *
   * Any member, not owner only: the settings this reads beside are the owner's, but what the
   * agent did is the company's, and a manager watching the agent answer should not have to
   * ask the owner what it cost.
   *
   * Two statements rather than one with `grouping sets`: neither reads the other's result, so
   * they go together, and the whole-period total is summed by Postgres in its own right — not
   * by adding the per-model rows up in Node, where the cost would stop being a string.
   */
  app.get(
    '/api/agents/:agentId/ai/usage',
    { preHandler: [guard, anyMember] },
    async (req): Promise<AiUsage> => {
      const parsed = periodQuery.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'Неизвестный период');
      const period = parsed.data.period ?? 'week';

      // Computed on the server and answered back, so the screen names the same instant the
      // numbers were counted from instead of guessing at one from its own clock.
      const since = periodSince(period);
      const window = and(eq(aiReplies.agentId, req.agent!.id), gte(aiReplies.createdAt, since));

      const [totalRows, modelRows] = await Promise.all([
        db.select(usageColumns).from(aiReplies).where(window),
        db
          .select({ model: aiReplies.model, ...usageColumns })
          .from(aiReplies)
          .where(window)
          .groupBy(aiReplies.model)
          // Busiest first — that is the model the owner is on. The model id breaks a tie so
          // two models with the same number of turns do not swap places between reloads.
          .orderBy(sql`count(*) desc`, asc(aiReplies.model)),
      ]);

      // `count(*)` over no rows is one row of zeros, not no rows: the emptiness has to be
      // recognised here, or the screen would report a month of free answers.
      const total = totalRows[0]!;
      const empty = total.turns === 0;

      return {
        period,
        since: since.toISOString(),
        total: empty ? null : toTotals(total),
        byModel: modelRows.map((row): AiUsageModel => ({ model: row.model, ...toTotals(row) })),
      };
    },
  );

  app.post(
    '/api/agents/:agentId/ai/sandbox',
    {
      preHandler: [guard, ownerOnly],
      // Every call spends the owner's own OpenRouter balance, so the route is bounded the
      // way the login route is.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req): Promise<AiTurn> => {
      const parsed = z
        .object({ text: z.string().trim().min(1).max(SANDBOX_LIMIT) })
        .safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Напишите сообщение клиента');

      // A real number, preferring an enabled one: a sandbox that invented a number would
      // report a delivered reply where a real turn refuses on a disabled one, which is the
      // one question the owner is asking it.
      const [number] = await db
        .select({ id: whatsappNumbers.id })
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.agentId, req.agent!.id))
        .orderBy(desc(whatsappNumbers.enabled), asc(whatsappNumbers.createdAt))
        .limit(1);
      if (!number) {
        throw new ApiError(409, 'Сначала подключите номер WhatsApp — агенту некуда отвечать');
      }

      // Taken before the turn and given back in a `finally`, so a turn that raises does not
      // leave the shared cap one slot poorer for the life of the process. The slot is taken
      // from the same counter the coach draws on — see `db/turn-cap.ts`.
      if (!tryTakeTurnSlot()) {
        throw new ApiError(429, 'Песочница занята. Попробуйте через несколько секунд.');
      }

      let result;
      try {
        // One message, no ops: the sandbox is a case of one, replayed against the store
        // exactly as it stands — see `replayCase` for the transaction that makes this safe
        // and generalises to the draft test runs built on top of it.
        result = await replayCase(db, deps, {
          agentId: req.agent!.id,
          numberId: number.id,
          key: credentialsKey(env),
          messages: [parsed.data.text],
          ops: [],
        });
      } finally {
        releaseTurnSlot();
      }

      // Ids become names here rather than on the screen: the sections and the fields are
      // the owner's own, and «Прайс на 2026 › Двери» is what tells them whether the answer
      // used the right one.
      const itemRows =
        result.usedChunkIds.length === 0
          ? []
          : await db
              .select({ id: kbChunks.id, title: kbChunks.title })
              .from(kbChunks)
              .where(inArray(kbChunks.id, result.usedChunkIds));
      const fieldIds = Object.keys(result.fields);
      const fieldRows =
        fieldIds.length === 0
          ? []
          : await db
              .select({ id: leadFields.id, name: leadFields.name })
              .from(leadFields)
              .where(inArray(leadFields.id, fieldIds));
      const [stage] =
        result.stageId === null
          ? []
          : await db
              .select({ name: stages.name })
              .from(stages)
              .where(eq(stages.id, result.stageId));

      return {
        reply: result.reply,
        // Mapped over the turn's own order, so the record the answer leaned on most is first.
        usedItems: result.usedChunkIds.flatMap((id) => {
          const found = itemRows.find((item) => item.id === id);
          return found ? [{ id, title: found.title }] : [];
        }),
        stageName: stage?.name ?? null,
        fields: Object.entries(result.fields).flatMap(([id, value]) => {
          const found = fieldRows.find((field) => field.id === id);
          return found ? [{ id, name: found.name, value }] : [];
        }),
        handoff: result.handoffReason,
        outcome: result.outcome,
        detail: result.detail,
      };
    },
  );

  app.patch(
    '/api/agents/:agentId/conversations/:conversationId/ai',
    // Any member: the operator watching the agent go wrong is the one who has to stop it,
    // and waiting for an owner to log in is not an option mid-conversation.
    { preHandler: [guard, anyMember] },
    async (req): Promise<{ aiEnabled: boolean }> => {
      const { conversationId } = req.params as { conversationId: string };
      // Comparing non-UUID text against a uuid column makes Postgres raise, which would turn
      // a typo into a 500.
      if (!isUuid(conversationId)) throw new ApiError(404, 'Диалог не найден');

      const parsed = z.object({ aiEnabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите, отвечает ли агент в этом диалоге');

      const [row] = await db
        .update(conversations)
        .set({ aiEnabled: parsed.data.aiEnabled })
        // The agent condition is what stops one account switching another's conversation
        // even when the identifier is guessed.
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.agentId, req.agent!.id),
          ),
        )
        .returning({ aiEnabled: conversations.aiEnabled });

      if (!row) throw new ApiError(404, 'Диалог не найден');
      return row;
    },
  );
}
