/**
 * What the owner sets about the agent, what they may pick, and the sandbox.
 *
 * The settings follow the path `whatsapp-numbers.ts` settled on for a WhatsApp token: the
 * key goes in and never comes out, and what a reader is told is whether one is stored.
 */
import type { AiModel, AiSettings, AiTurn } from '@rakurs/contract';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { POOL_MAX, type Db } from '../db/client.js';
import {
  agents,
  contacts,
  conversations,
  kbItems,
  leadFields,
  messages,
  stages,
  whatsappNumbers,
} from '../db/schema.js';
import type { Env } from '../env.js';
import { MODELS, type ModelClient } from '../lib/ai/openrouter.js';
import { keyAad, runTurn, type TurnResult } from '../lib/ai/turn.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import type { GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';

export interface AiDeps {
  model: ModelClient;
  /** The sandbox runs the same turn a customer would get, and a turn takes a Graph client. */
  graph: GraphClient;
}

/** Long enough for a real sales brief, short enough that a paste cannot fill a column. */
const INSTRUCTIONS_LIMIT = 20_000;

/** What a customer may say to the sandbox. A WhatsApp message is far shorter than this. */
const SANDBOX_LIMIT = 4_000;

/**
 * Sandbox turns allowed to run at once, across the whole process.
 *
 * A sandbox turn holds a database connection for as long as the model thinks — up to the
 * client's sixty-second deadline — because the transaction it rolls back is what keeps an
 * invented customer out of somebody's inbox. Connections are `POOL_MAX` and shared with every
 * other route, so without a cap a handful of owners clicking «Проверить» empties the pool and
 * the webhook Meta is waiting on queues behind them for a minute.
 *
 * Three is the intent, and the pool is the ceiling: written against `POOL_MAX` so that
 * shrinking the pool cannot silently make this cap the larger of the two.
 *
 * The rate limit does not do this job. Twenty a minute is above the pool size to begin with,
 * and a count per minute says nothing about how many are in flight at one instant.
 */
export const SANDBOX_TURNS = Math.min(3, POOL_MAX - 2);

/**
 * How many are in flight now. Module-level rather than per-server, because what it protects —
 * the connection pool — belongs to the process, and a second `buildServer` in one process
 * would share the pool without sharing a counter.
 */
let sandboxTurnsInFlight = 0;

const settings = z
  .object({
    aiEnabled: z.boolean().optional(),
    model: z.string().trim().optional(),
    temperature: z.number().min(0).max(2).optional(),
    instructions: z.string().max(INSTRUCTIONS_LIMIT).optional(),
    replyLanguage: z.string().trim().min(1).max(40).optional(),
    // Optional and nullable are different things here: absent leaves the stored key alone,
    // and an explicit null clears it.
    openrouterKey: z.string().trim().min(1).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);

/** The key is never part of this. Only whether there is one. */
const toApi = (row: typeof agents.$inferSelect): AiSettings => ({
  aiEnabled: row.aiEnabled,
  model: row.model,
  temperature: Number(row.temperature),
  instructions: row.instructions,
  replyLanguage: row.replyLanguage,
  keySet: row.openrouterKey !== null,
});

/**
 * The sandbox's result, carried out of the transaction by the exception that rolls it back.
 *
 * Drizzle rolls a transaction back when its callback throws and rethrows what was thrown, so
 * a throw is both the rollback and the return. Ours rather than `tx.rollback()`, because
 * that one is recognised by an error class this file would then have to import and keep in
 * step with the ORM; a private class cannot be confused with a real failure.
 */
class SandboxDone extends Error {
  constructor(readonly result: TurnResult) {
    super('sandbox finished');
    this.name = 'SandboxDone';
  }
}

/**
 * One turn on a conversation that never existed.
 *
 * `runTurn` reads everything a turn knows from the database and takes no free text, so the
 * sandbox has to give it a conversation to read. It creates one — a contact, a thread on a
 * real number and the customer's line — inside a transaction that is always rolled back, so
 * the turn sees exactly the shape a real one sees and the cabinet is left as it was found.
 *
 * A transaction rather than «create, then delete afterwards»: a delete in a `finally` leaves
 * rows behind if the process dies mid-turn, and the one thing this must never do is put a
 * fake customer into somebody's inbox. `dryRun` already stops every write `runTurn` makes;
 * the rollback is what covers the rows this route makes to call it with, and it would cover
 * a regression in `dryRun` as well.
 *
 * The turn is handed the transaction, which is the same query interface under a type Drizzle
 * keeps separate from `Db` — hence the one cast. Nothing `runTurn` reaches for in a dry run
 * lives outside it: no `$client`, and the sending path stops before the Graph call.
 */
async function sandboxTurn(
  db: Db,
  deps: AiDeps,
  input: { agentId: string; numberId: string; key: Buffer; text: string },
): Promise<TurnResult> {
  try {
    await db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({
          agentId: input.agentId,
          // Unique per agent, and unlike any phone number, so it cannot collide with a real
          // contact even in the instant before the rollback.
          phone: `sandbox-${randomUUID()}`,
          name: 'Песочница',
        })
        .returning();

      const now = new Date();
      const [conversation] = await tx
        .insert(conversations)
        .values({
          agentId: input.agentId,
          contactId: contact!.id,
          whatsappNumberId: input.numberId,
          // The window is checked in a dry run too, and a sandbox that refused because a
          // conversation invented a second ago is stale would be answering nothing.
          lastInboundAt: now,
          lastMessageAt: now,
        })
        .returning();

      await tx.insert(messages).values({
        conversationId: conversation!.id,
        direction: 'in',
        author: 'client',
        kind: 'text',
        body: input.text,
        sentAt: now,
      });

      const result = await runTurn(
        tx as unknown as Db,
        { model: deps.model, graph: deps.graph, key: input.key },
        { agentId: input.agentId, conversationId: conversation!.id, dryRun: true },
      );
      throw new SandboxDone(result);
    });
  } catch (error) {
    if (error instanceof SandboxDone) return error.result;
    throw error;
  }
  // The callback above always throws, which the compiler has no way of knowing.
  throw new Error('sandbox transaction returned without a result');
}

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
    async (req): Promise<AiSettings> => toApi(req.agent!),
  );

  app.patch(
    '/api/agents/:agentId/ai',
    // Owner only: the instructions are what the agent says to customers in the business's
    // name, and the key is what the business pays with.
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<AiSettings> => {
      const parsed = settings.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки агента');
      const { aiEnabled, model, temperature, instructions, replyLanguage, openrouterKey } =
        parsed.data;

      // A list, not free text: an id OpenRouter does not know would be learned about from a
      // customer's silence.
      if (model !== undefined && !MODELS.some((known) => known.id === model)) {
        throw new ApiError(400, 'Неизвестная модель');
      }

      const changes: Partial<typeof agents.$inferInsert> = {};
      if (aiEnabled !== undefined) changes.aiEnabled = aiEnabled;
      if (model !== undefined) changes.model = model;
      // The column is numeric(3,2) and hands back a string; two decimals is all it keeps.
      if (temperature !== undefined) changes.temperature = temperature.toFixed(2);
      if (instructions !== undefined) changes.instructions = instructions;
      if (replyLanguage !== undefined) changes.replyLanguage = replyLanguage;
      if (openrouterKey !== undefined) {
        changes.openrouterKey =
          openrouterKey === null
            ? null
            : // Sealed with the agent's id, exactly as `runTurn` opens it: a row copied into
              // another agent decrypts to nothing rather than to a working key.
              encryptSecret(openrouterKey, credentialsKey(env), keyAad(req.agent!.id));
      }

      // An agent left on with no key skips every message in silence, and the only place that
      // silence shows is the reply log. Refused here — in the words of what the owner just
      // asked for, because «добавьте ключ» in answer to «удалите ключ» tells them to do the
      // opposite of what they wanted.
      const keyAfter =
        openrouterKey !== undefined ? changes.openrouterKey : req.agent!.openrouterKey;
      const enabledAfter = aiEnabled ?? req.agent!.aiEnabled;
      if (enabledAfter && !keyAfter) {
        throw new ApiError(
          400,
          openrouterKey === null
            ? 'Сначала выключите агента: без ключа он не сможет отвечать'
            : 'Сначала добавьте ключ OpenRouter',
        );
      }

      const [row] = await db
        .update(agents)
        .set(changes)
        .where(eq(agents.id, req.agent!.id))
        .returning();
      return toApi(row!);
    },
  );

  // No agent in the path: the list is the same for everyone and says nothing about anybody's
  // business. A session is still required — it is not the public's list.
  app.get('/api/ai/models', { preHandler: [guard] }, async (): Promise<AiModel[]> =>
    MODELS.map((model) => ({ ...model })),
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
      // leave the sandbox one slot poorer for the life of the process. See `SANDBOX_TURNS`.
      if (sandboxTurnsInFlight >= SANDBOX_TURNS) {
        throw new ApiError(429, 'Песочница занята. Попробуйте через несколько секунд.');
      }
      sandboxTurnsInFlight += 1;

      let result;
      try {
        result = await sandboxTurn(db, deps, {
          agentId: req.agent!.id,
          numberId: number.id,
          key: credentialsKey(env),
          text: parsed.data.text,
        });
      } finally {
        sandboxTurnsInFlight -= 1;
      }

      // Ids become names here rather than on the screen: the records and the fields are the
      // owner's own, and «Прайс на 2026» is what tells them whether the answer used the
      // right one.
      const itemRows =
        result.usedItemIds.length === 0
          ? []
          : await db
              .select({ id: kbItems.id, title: kbItems.title })
              .from(kbItems)
              .where(inArray(kbItems.id, result.usedItemIds));
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
        usedItems: result.usedItemIds.flatMap((id) => {
          const found = itemRows.find((item) => item.id === id);
          return found ? [{ id, title: found.title }] : [];
        }),
        stageName: stage?.name ?? null,
        fields: Object.entries(result.fields).flatMap(([id, value]) => {
          const found = fieldRows.find((field) => field.id === id);
          return found ? [{ id, name: found.name, value }] : [];
        }),
        handoff: result.handoff,
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
