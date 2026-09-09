/**
 * The coaching conversation: an owner teaching the agent, one line at a time.
 *
 * `lib/ai/coach.ts` builds the prompt and calls the model; `lib/ai/fact-check.ts` keeps a
 * fact out of a rule proposal; both run inside `runCoach` itself. This file is the seam that
 * turns an HTTP request into the `CoachContext` those two need, and the one table this whole
 * feature is allowed to write on the way there: a `coach_messages` row per turn, never
 * `agent_rules`, never `kb_notes` — a proposal only ever reaches those tables through a draft,
 * which belongs to a later plan (`POST …/messages/:id/draft`, not written here).
 *
 * ## Why the route queries `agent_rules` itself rather than calling `loadRules`
 *
 * `lib/ai/rules.ts`'s `loadRules` answers one question — what the prompt reads right now —
 * and deliberately drops disabled rules to answer it, because a disabled rule is not read
 * into `assembleRules` and is not one of the number guard's sources either. The coach is
 * answering a different question: what rules exist to talk about, including the one the
 * owner is about to say "turn that back on". So this file runs its own query, unfiltered by
 * `enabled`, and carries the id `loadRules` throws away — the id is what a `rule_edit`
 * proposal names.
 *
 * ## Why a missing key is refused before a turn is attempted
 *
 * `runCoach` answers a missing OpenRouter key with a readable sentence rather than throwing,
 * the same one `runTurn` uses — a courtesy for a chat that got this far for some other
 * reason (an owner clears the key mid-conversation). A *fresh* coaching turn with no key at
 * all has nothing to gain from that path: it would still spend a database round trip loading
 * rules, note paths and history, hold an in-flight slot for the length of a call that can
 * only ever answer one way, and store an owner line with no model line to answer it. Refused
 * outright, with the same 409 the settings route already uses for "no key, no turn".
 *
 * ## Why the in-flight cap is `SANDBOX_TURNS`, and the counter behind it shared
 *
 * A coaching turn holds a database connection for exactly the reason `api/ai.ts` names for
 * the sandbox: the model is thinking on the other end of it. When the model proposes a rule
 * it costs more than usual — `checkProposal` runs inside `runCoach` and reads `kb_chunks` and
 * `agent_rules` before it returns — but it is still one connection held for one call, the
 * same shape `SANDBOX_TURNS` was sized against. What the pool feels is how many connections
 * are held at once, not which feature is holding them, so the counter behind the cap is one
 * counter, not one per feature — `db/turn-cap.ts`'s `tryTakeTurnSlot`/`releaseTurnSlot`,
 * shared with the sandbox. A busy sandbox now leaves the coach exactly as little room as it
 * would leave a fourth sandbox call, and the other way round.
 *
 * ## Why a coach message may carry `aiReplyId`
 *
 * When a coaching turn names a conversation, the owner is very likely coaching about
 * something the agent just did — including a turn that never became a message (a handoff, a
 * failed send). `ai_replies` is where that turn is recorded even when `messages` has nothing
 * to show for it, so this file loads the conversation's most recent `ai_replies` row and
 * stamps its id onto both `coach_messages` rows this turn writes. That id is bookkeeping for
 * now — a link a later drafts screen can use to show "this coaching thread was about that
 * reply" — and not fed into the prompt itself: the transcript already carries whatever the
 * agent actually sent, and `ai_replies` has no column with the text of a turn that failed to.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agentRules, aiReplies, coachMessages, conversations, kbNotes, messages } from '../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import {
  runCoach,
  type CoachContext,
  type CoachRule,
  type CoachTurn,
  type RuleCategory,
  type TranscriptLine,
} from '../lib/ai/coach.js';
import type { ModelClient } from '../lib/ai/openrouter.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

export interface CoachApiDeps {
  model: ModelClient;
}

/** What the owner may say to the coach in one turn. Generous: this is a person explaining
 * how their business works, not a customer's WhatsApp message. */
const COACH_LIMIT = 4_000;

/** How many earlier turns of this coaching conversation the model gets to read, and how many
 * the `GET` route hands back. One page, not a paginated feed — a coaching chat is read start
 * to end, and a business large enough to fill a hundred turns is a problem for another day. */
const HISTORY_LIMIT = 100;

/** How many lines of the named conversation become the transcript. `prompt.ts`'s own history
 * window for a live turn; carried over so the coach reads the same slice of the dialog the
 * agent itself would have. */
const TRANSCRIPT_LIMIT = 20;

const postBody = z.object({
  text: z.string().trim().min(1).max(COACH_LIMIT),
  // A UUID we look up, not one we trust: an unknown or foreign id answers 404 below, the same
  // way a mistyped conversation id already does on `PATCH …/conversations/:conversationId/ai`.
  conversationId: z.string().trim().min(1).optional(),
});

const toMessage = (row: typeof coachMessages.$inferSelect) => ({
  id: row.id,
  role: row.role as 'owner' | 'model',
  text: row.text,
  proposal: row.proposal ?? null,
  status: row.status as 'pending' | 'drafted' | 'rejected',
  conversationId: row.conversationId,
  createdAt: row.createdAt.toISOString(),
});

/** Every rule this agent has, enabled or not, in the order the owner arranged them — see the
 * file comment for why this does not reuse `lib/ai/rules.ts`'s `loadRules`. */
async function allRules(db: Db, agentId: string): Promise<CoachRule[]> {
  const rows = await db
    .select({ id: agentRules.id, category: agentRules.category, text: agentRules.text })
    .from(agentRules)
    .where(eq(agentRules.agentId, agentId))
    .orderBy(asc(agentRules.category), asc(agentRules.position));
  return rows.map((row) => ({ id: row.id, category: row.category as RuleCategory, text: row.text }));
}

/** Every note path this agent's vault holds — see `CoachContext.notePaths`. */
async function notePathsFor(db: Db, agentId: string): Promise<string[]> {
  const rows = await db.select({ path: kbNotes.path }).from(kbNotes).where(eq(kbNotes.agentId, agentId));
  return rows.map((row) => row.path);
}

/** The coaching chat so far, oldest first, capped at `HISTORY_LIMIT`. Read before this turn's
 * own owner line is written, so the caller can append that line itself without asking this
 * function to somehow exclude a row it has not written yet. */
async function recentHistory(db: Db, agentId: string): Promise<CoachTurn[]> {
  const rows = await db
    .select({ role: coachMessages.role, text: coachMessages.text })
    .from(coachMessages)
    .where(eq(coachMessages.agentId, agentId))
    .orderBy(desc(coachMessages.createdAt))
    .limit(HISTORY_LIMIT);
  return rows.reverse().map((row) => ({ role: row.role as 'owner' | 'model', text: row.text }));
}

/** The named conversation's last `TRANSCRIPT_LIMIT` messages, oldest first — data for the
 * coach to read, never an instruction, exactly as `buildCoachMessages` fences it. */
async function transcriptFor(db: Db, conversationId: string): Promise<TranscriptLine[]> {
  const rows = await db
    .select({ author: messages.author, body: messages.body })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sentAt))
    .limit(TRANSCRIPT_LIMIT);
  return rows.reverse().map((row) => ({ author: row.author, text: row.body ?? '' }));
}

/** The most recent `ai_replies` row for a conversation, or null when the agent has never
 * answered in it. See the file comment for what this id is used for. */
async function latestReplyId(db: Db, conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: aiReplies.id })
    .from(aiReplies)
    .where(eq(aiReplies.conversationId, conversationId))
    .orderBy(desc(aiReplies.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** The named conversation's id, only if it belongs to this agent — 404 either way, so a
 * stranger's conversation id is indistinguishable from one that does not exist at all. */
async function ownConversation(db: Db, agentId: string, conversationId: string): Promise<string> {
  if (!isUuid(conversationId)) throw new ApiError(404, 'Диалог не найден');
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));
  if (!row) throw new ApiError(404, 'Диалог не найден');
  return row.id;
}

export function registerCoachRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  deps: CoachApiDeps,
): void {
  // Coaching is owner-only, the same as the rules it may end up proposing — every route
  // below, the read included.
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const key = credentialsKey(env);

  app.get(
    '/api/agents/:agentId/coach/messages',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const rows = await db
        .select()
        .from(coachMessages)
        .where(eq(coachMessages.agentId, req.agent!.id))
        .orderBy(desc(coachMessages.createdAt))
        .limit(HISTORY_LIMIT);
      return rows.reverse().map(toMessage);
    },
  );

  app.post(
    '/api/agents/:agentId/coach/messages',
    {
      preHandler: [guard, ownerOnly],
      // The same balance the sandbox spends, under the same bound `api/ai.ts` gives it.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const agentId = req.agent!.id;
      const parsed = postBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Напишите сообщение агенту-коучу');

      // Refused before anything else runs — see the file comment for why this is not left
      // to `runCoach`'s own readable-sentence answer.
      if (req.agent!.openrouterKey === null) {
        throw new ApiError(409, 'Не задан ключ OpenRouter');
      }

      const conversationId =
        parsed.data.conversationId === undefined
          ? null
          : await ownConversation(db, agentId, parsed.data.conversationId);

      // Taken before the turn and given back in a `finally`, so a turn that raises does not
      // leave the shared cap one slot poorer for the life of the process. The slot is taken
      // from the same counter the sandbox draws on — see `db/turn-cap.ts`.
      if (!tryTakeTurnSlot()) {
        throw new ApiError(429, 'Коуч занят. Попробуйте через несколько секунд.');
      }

      try {
        const [rules, notePaths, history, transcript, replyId] = await Promise.all([
          allRules(db, agentId),
          notePathsFor(db, agentId),
          recentHistory(db, agentId),
          conversationId === null ? Promise.resolve(null) : transcriptFor(db, conversationId),
          conversationId === null ? Promise.resolve(null) : latestReplyId(db, conversationId),
        ]);

        await db.insert(coachMessages).values({
          agentId,
          role: 'owner',
          text: parsed.data.text,
          conversationId,
          aiReplyId: replyId,
        });

        const context: CoachContext = {
          company: req.agent!.name,
          rules,
          notePaths,
          // The line just stored joins the end of what the model reads, not a second query
          // for a row this request just wrote — see `recentHistory`.
          history: [...history, { role: 'owner', text: parsed.data.text }],
          transcript,
        };

        const result = await runCoach(db, { model: deps.model, key }, { agentId, context });

        const [modelRow] = await db
          .insert(coachMessages)
          .values({
            agentId,
            role: 'model',
            text: result.text,
            proposal: result.proposal,
            conversationId,
            aiReplyId: replyId,
          })
          .returning();

        return {
          id: modelRow!.id,
          message: result.text,
          proposal: result.proposal,
          warning: result.warning,
        };
      } finally {
        releaseTurnSlot();
      }
    },
  );

  app.post(
    '/api/agents/:agentId/coach/messages/:id/reject',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const { id } = req.params as { id: string };
      if (!isUuid(id)) throw new ApiError(404, 'Сообщение не найдено');

      const [row] = await db
        .update(coachMessages)
        .set({ status: 'rejected' })
        .where(and(eq(coachMessages.id, id), eq(coachMessages.agentId, agentId)))
        .returning();
      if (!row) throw new ApiError(404, 'Сообщение не найдено');

      return toMessage(row);
    },
  );

  // POST /api/agents/:agentId/coach/messages/:id/draft belongs to a later plan: it is what
  // turns a checked proposal into an `agent_rules` or `kb_notes` row. Not written here — see
  // the file comment.
}
