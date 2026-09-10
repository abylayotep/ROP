/**
 * The coaching conversation: an owner teaching the agent, one line at a time.
 *
 * `lib/ai/coach.ts` builds the prompt and calls the model; `lib/ai/fact-check.ts` keeps a
 * fact out of a rule proposal; both run inside `runCoach` itself. This file is the seam that
 * turns an HTTP request into the `CoachContext` those two need, and the one table this whole
 * feature is allowed to write on the way there: a `coach_messages` row per turn, never
 * `agent_rules`, never `kb_notes` — a proposal only ever reaches those tables through a draft.
 * `POST …/messages/:id/draft`, the route that turns one into a draft, is registered by
 * `api/drafts.ts` instead — see this file's trailing comment.
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
 * ## Why a coach message may carry `aiReplyId`, and why only a client-given one reaches the prompt
 *
 * When a coaching turn names a conversation, the owner is very likely coaching about
 * something the agent just did — including a turn that never became a message (a handoff, a
 * failed send). `ai_replies` is where that turn is recorded even when `messages` has nothing
 * to show for it, so every coaching turn on a named conversation stamps a reply id onto both
 * `coach_messages` rows it writes — bookkeeping a later drafts screen can use to show "this
 * coaching thread was about that reply".
 *
 * By default that id is the conversation's *most recent* reply (`latestReplyId`), the same
 * guess this file always made. A request may instead name one particular reply — the exact
 * turn a «Так нельзя» button sat on, which need not be the dialog's latest at all, since the
 * button reaches into a transcript the owner may be scrolled well past the end of. Only that
 * case is worth the extra query and the extra prompt text: `ownReply` checks the id actually
 * belongs to the named conversation and this agent, and its `usedItemIds` are resolved to
 * `kb_chunks` titles and handed to `buildCoachMessages` as `citedSections`, so the model can
 * say "he answered from «Доставка › По городу»" instead of guessing which part of a
 * twenty-line transcript produced a number. A conversation named with no particular reply
 * still gets the transcript and the bookkeeping id, exactly as before this field mattered to
 * the prompt — the transcript already carries whatever the agent actually sent, and guessing
 * which section produced a *correct* answer is not this feature's job.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  agentRules,
  aiReplies,
  coachMessages,
  conversations,
  kbChunks,
  kbNotes,
  messages,
} from '../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import {
  runCoach,
  budgetHistory,
  HISTORY_BUDGET_CHARS,
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
  // The particular reply this turn is about, named by whoever clicked «Так нельзя» on a
  // dialog's message — see the file comment for why this, and not `conversationId` alone,
  // is what lets the prompt say which section a wrong answer came from.
  aiReplyId: z.string().trim().min(1).optional(),
});

const toMessage = (row: typeof coachMessages.$inferSelect) => ({
  id: row.id,
  role: row.role as 'owner' | 'model',
  text: row.text,
  proposal: row.proposal ?? null,
  warning: row.warning,
  status: row.status as 'pending' | 'drafted' | 'rejected',
  // `coach_messages` has no `draft_id` column yet — the drafts plan (`…/messages/:id/draft`)
  // is what adds both the column and its one writer. Until then every row answers the
  // contract's `draftId: null` honestly: no proposal here has ever become a draft.
  draftId: null,
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

/** The coaching chat so far, oldest first, capped at `HISTORY_LIMIT` rows and then at
 * `HISTORY_BUDGET_CHARS` characters — see that constant for why a row count alone is not
 * enough. Read before this turn's own owner line is written, so the caller can append that
 * line itself without asking this function to somehow exclude a row it has not written yet. */
async function recentHistory(db: Db, agentId: string): Promise<CoachTurn[]> {
  const rows = await db
    .select({ role: coachMessages.role, text: coachMessages.text })
    .from(coachMessages)
    .where(eq(coachMessages.agentId, agentId))
    .orderBy(desc(coachMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const turns = rows.reverse().map((row) => ({ role: row.role as 'owner' | 'model', text: row.text }));
  return budgetHistory(turns, HISTORY_BUDGET_CHARS);
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

/** The named reply, only if it belongs to this agent's named conversation — 404 either way,
 * the same reason `ownConversation` treats a foreign or mismatched id as not found at all. */
async function ownReply(
  db: Db,
  agentId: string,
  conversationId: string,
  aiReplyId: string,
): Promise<{ id: string; usedItemIds: string[] }> {
  if (!isUuid(aiReplyId)) throw new ApiError(404, 'Ответ агента не найден');
  const [row] = await db
    .select({ id: aiReplies.id, usedItemIds: aiReplies.usedItemIds })
    .from(aiReplies)
    .where(
      and(
        eq(aiReplies.id, aiReplyId),
        eq(aiReplies.agentId, agentId),
        eq(aiReplies.conversationId, conversationId),
      ),
    );
  if (!row) throw new ApiError(404, 'Ответ агента не найден');
  return row;
}

/** The titles of the sections a reply cited, in the order `usedItemIds` names them —
 * `kb_chunks.title` is «Заметка › Раздел», the string a wrong answer needs pointed at. An id
 * a reimport or an edit has since removed is simply dropped, not replaced by a placeholder:
 * a citation that no longer resolves is worth less than one, not worth a broken one. */
async function sectionTitlesFor(db: Db, agentId: string, itemIds: readonly string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const rows = await db
    .select({ id: kbChunks.id, title: kbChunks.title })
    .from(kbChunks)
    .where(and(eq(kbChunks.agentId, agentId), inArray(kbChunks.id, itemIds)));
  const titleById = new Map(rows.map((row) => [row.id, row.title]));
  return itemIds.map((id) => titleById.get(id)).filter((title): title is string => title !== undefined);
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
        // The reply this turn is about, and — only when the request named one specifically
        // rather than just the conversation — the sections it cited. Resolved ahead of the
        // `Promise.all` below because `citedSections` reads `ownReply`'s own result; asking
        // for the same row twice in parallel would be one query this route does not need.
        let replyId: string | null = null;
        let citedSections: string[] | null = null;
        if (conversationId !== null) {
          if (parsed.data.aiReplyId === undefined) {
            replyId = await latestReplyId(db, conversationId);
          } else {
            const reply = await ownReply(db, agentId, conversationId, parsed.data.aiReplyId);
            replyId = reply.id;
            citedSections = await sectionTitlesFor(db, agentId, reply.usedItemIds);
          }
        }

        const [rules, notePaths, history, transcript] = await Promise.all([
          allRules(db, agentId),
          notePathsFor(db, agentId),
          recentHistory(db, agentId),
          conversationId === null ? Promise.resolve(null) : transcriptFor(db, conversationId),
        ]);

        // Returns its own `createdAt` — Postgres's clock, stamped right after the store above
        // was read — so the model row below can carry it as `contextAt`: the instant the
        // proposal it is about to write was actually written against, not the instant the
        // model happens to finish answering. See `coach_messages.contextAt`'s own comment.
        const [ownerRow] = await db
          .insert(coachMessages)
          .values({
            agentId,
            role: 'owner',
            text: parsed.data.text,
            conversationId,
            aiReplyId: replyId,
          })
          .returning({ createdAt: coachMessages.createdAt });

        const context: CoachContext = {
          company: req.agent!.name,
          rules,
          notePaths,
          // The line just stored joins the end of what the model reads, not a second query
          // for a row this request just wrote — see `recentHistory`.
          history: [...history, { role: 'owner', text: parsed.data.text }],
          transcript,
          citedSections,
        };

        const result = await runCoach(db, { model: deps.model, key }, { agentId, context });

        const [modelRow] = await db
          .insert(coachMessages)
          .values({
            agentId,
            role: 'model',
            text: result.text,
            proposal: result.proposal,
            warning: result.warning,
            conversationId,
            aiReplyId: replyId,
            contextAt: ownerRow!.createdAt,
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

  // POST /api/agents/:agentId/coach/messages/:id/draft is what turns a checked proposal into
  // a draft — registered by `api/drafts.ts`, not here: turning a proposal into a `DraftOp` is
  // that file's whole job, the same mapping a manually-built draft goes through. A proposal
  // still never reaches `agent_rules` or `kb_notes` directly from this route — only through
  // the draft it becomes, and later, an apply this plan does not yet write.
}
