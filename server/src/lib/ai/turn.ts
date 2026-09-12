/**
 * One turn, end to end: gather, build, call, validate, apply, send, log.
 *
 * Everything a turn knows is read here and nothing is carried between turns. Task 5 calls
 * this from the inbound queue, after Meta has already had its 200, so a slow model cannot
 * make Meta retry the webhook; task 6 calls it with `dryRun` for the sandbox.
 *
 * ## Why `dryRun` is a flag and not a second function
 *
 * The sandbox has to answer «what would the agent do» — and an answer produced by different
 * code answers a different question. So there is one path, and the flag is checked at each
 * write. The gather, the prompt, the model call, the parse, the retry, every refusal and
 * every check that stands between a reply and the customer are literally the same lines in
 * both modes; the flag skips the writes and `graph.sendText`, and nothing else.
 *
 * The one thing a dry run does not honour is the two `aiEnabled` switches. An agent starts
 * switched off by design — the owner writes instructions first and turns it on when the
 * sandbox has convinced them — so a sandbox that refused to run while the switch was off
 * would be unusable on exactly the agent that needs it. Every other refusal stands in both
 * modes, including the closed window and the last word not being the customer's.
 */
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { windowOpen } from '../../api/conversations.js';
import type { Db } from '../../db/client.js';
import {
  agents,
  aiReplies,
  contacts,
  conversations,
  leadFields,
  leadValues,
  messages,
  notes,
  stages,
  whatsappNumbers,
} from '../../db/schema.js';
import { hasConfirmedKaspiPayment } from '../kaspi/service.js';
import {
  decideAutomation,
  loadAutomationSnapshot,
  type AutomationPurpose,
} from '../automation/policy.js';
import { queueLead } from '../capi/enqueue.js';
import { recordStageMove } from '../funnel-history.js';
import { sendStageMessage } from '../funnel-message.js';
import { searchKnowledge } from '../knowledge/search.js';
import { decryptSecret } from '../secret-box.js';
import { GraphError, withoutSecret, type GraphClient } from '../whatsapp/graph.js';
import type { LinkedClient } from '../whatsapp/linked/client.js';
import { markTokenRejected } from '../whatsapp/token-expiry.js';
import { transportFor, type MessageTransport } from '../whatsapp/transport.js';
import { ModelError, type ChatMessage, type ModelClient } from './openrouter.js';
import {
  buildMessages,
  HISTORY_LIMIT,
  KNOWLEDGE_LIMIT,
  REPLY_SCHEMA,
  type AgentReply,
  type TurnContext,
} from './prompt.js';
import { assembleRules, loadRules } from './rules.js';

export interface TurnDeps {
  /** Independent CRM processing; true means payment instructions already answered the client. */
  crm?: (agentId: string, conversationId: string) => Promise<boolean>;
  model: ModelClient;
  graph: GraphClient;
  /** The other way out. A Cloud API number never touches it, and vice versa. */
  linked: LinkedClient;
  /** The credentials key. Both secrets a turn touches are sealed with it. */
  key: Buffer;
}

export interface TurnInput {
  agentId: string;
  conversationId: string;
  /** The sandbox: everything happens except the writes and the send. */
  dryRun?: boolean;
}

/**
 * How a turn ended, and the only values `ai_replies.outcome` ever holds.
 *
 * Six rather than four, because two of them answer «may this be run again?» and a caller
 * that cannot tell them apart sends a customer the same sentence twice:
 *
 * - `sent` — the customer has the reply and we have the row.
 * - `unrecorded` — Meta accepted the reply and the row failed. **The customer has it.**
 *   Nothing may send it again; the reply is lost only to our own thread, and `detail` says so.
 * - `applied` — the lead was updated and there was nothing to say. Not `failed`: its
 *   consequences already happened, and replaying it would repeat them.
 * - `handoff` — a person now owns this thread.
 * - `failed` — nothing reached the customer. Safe to run again.
 * - `skipped` — the turn refused before spending anything, or the thread moved under it.
 */
export type TurnOutcome = 'sent' | 'unrecorded' | 'applied' | 'handoff' | 'failed' | 'skipped';

export interface TurnResult {
  outcome: TurnOutcome;
  /**
   * The reply the agent produced for the customer. Null when it produced none, and when the
   * reply was withheld — a number nothing the agent read contains is not shown to anyone.
   */
  reply: string | null;
  /** The knowledge records the answer was built from, minus any the model was not given. */
  usedItemIds: string[];
  /** The stage the lead was moved to, or would have been. Null when it did not move. */
  stageId: string | null;
  /** The fields that were filled, or would have been. Unknown ids are already gone. */
  fields: Record<string, string>;
  /**
   * Why the thread was left to a person, or null when it was not. Set exactly when `outcome`
   * is `handoff`, and it is the same sentence the note on the conversation carries.
   *
   * Separate from `detail`, which stays null on a handoff the model asked for: `detail`
   * explains an ending the reader did not expect, and a handoff is a decision. An owner
   * reading a sandbox turn needs the reason more than any other line it produces — «передал
   * человеку» with no «почему» is the one answer they cannot act on.
   */
  handoff: string | null;
  /** Why it ended the way it did, when that is worth telling anyone. Never carries a key. */
  detail: string | null;
}

/**
 * The additional associated data the OpenRouter key is sealed with.
 *
 * The agent's own id, the way a WhatsApp token is sealed against its `phoneNumberId`: a row
 * copied into another agent decrypts to nothing rather than to a working key. Task 5's
 * `PATCH /ai` seals it with the same value.
 */
export const keyAad = (agentId: string): string => agentId;

/** How much of anyone else's text a `detail` or a note will carry. */
const DETAIL_LIMIT = 500;
const AUTOMATION_DISABLED = 'Автоматизация для диалога выключена.';

/**
 * Why a reply stating a number nobody gave the agent is not sent.
 *
 * The prompt asks the model for this and the model usually obliges, but a rule that lives
 * only in a prompt is a request rather than a property of the system — and the one rule this
 * whole stage rests on is that the agent states no fact the knowledge base did not give it.
 * A digit is where that rule is cheapest to check and most expensive to break: prices,
 * dates, sizes and phone numbers are what a customer acts on.
 *
 * The number is named, because a person reading the note has to know which one to check.
 * Sliced, because the run is written by the model and lands in a column an owner reads.
 */
const UNSOURCED = (value: string): string =>
  `в ответе есть число «${value.slice(0, 40)}», которого нет ни в записях, на которые ` +
  'сослалась модель, ни в словах клиента, ни в инструкциях владельца';

/**
 * A number's own separators, removed, so one number written two ways is one number.
 *
 * Two readings, because no single one is right for both of the shapes a number arrives in.
 *
 * `spaced` joins only whitespace between two digits: `1 500` is `1500`. `\s` in a unicode
 * regex already covers the non-breaking and narrow spaces a price is typed with — U+00A0,
 * U+2009, U+202F. `punctuated` joins the brackets and dashes too, so a phone number retyped
 * as `8 (777) 123-45-67` is the record's `87771234567`.
 *
 * Only ever between two digits. A dash between words is a dash, and joining those would let
 * a reply's `15` come out of «1 дверь, 5 окон».
 */
const SPACED = /(?<=\p{Nd})\s+(?=\p{Nd})/gu;
const PUNCTUATED = /(?<=\p{Nd})[\s()\-\u2013\u2014]+(?=\p{Nd})/gu;

/** Every whole number in the text, under one of the two readings. */
function digitRuns(text: string, joiner: RegExp): string[] {
  return text.replace(joiner, '').match(/\p{Nd}+/gu) ?? [];
}

/**
 * The first number in the reply that appears in none of the texts the agent was given.
 *
 * `\p{Nd}` rather than `\d`: `\d` is ASCII-only, and a model answering a Kazakhstani customer
 * can write Eastern Arabic digits.
 *
 * ## Whole numbers, not substrings
 *
 * A run has to *be* one of the numbers the agent was given, not merely sit inside one. The
 * first version of this check asked for containment and let through the likeliest
 * hallucination there is — a truncation: `150` passed against a record's `1500`, `20` against
 * a `2026`, and a single digit passed on any source that held one anywhere.
 *
 * ## Why each side is read twice
 *
 * Containment was there to spare the phone number, and reading both sides twice spares it
 * without the loophole. A source lends every run of both its readings: `1500-2000 ₸` lends
 * `1500`, `2000` **and** `15002000`, so a price quoted out of a range still matches, and
 * `8 (777) 123-45-67` lends `87771234567`. A reply is honest when either of *its* readings is
 * wholly covered — the phone passes on its joined reading, a range quoted from two separate
 * records passes on its spaced one, and `150` is missing from both.
 *
 * Each source is read on its own. Concatenated, a record ending in `1500` and the next one
 * opening with `20000` would together lend a reply the number `50020`, which neither says.
 *
 * ## What this still cannot catch
 *
 * A fact stated in words rather than in digits — «три тысячи тенге», «доставка бесплатная»,
 * «работаем с прошлого года» — passes, because there is no digit run in it to check. And a
 * non-numeric invention — «гарантия есть», «монтаж входит в стоимость», an address — passes
 * for the same reason.
 *
 * Nor does it know what a number *means*. A customer who writes «участок 500 метров» has put
 * `500` among the sources, and a reply pricing something at «500 ₸» is then a number the
 * agent was given, used for something else entirely. Units and roles are semantics, and the
 * customer's own message has to be a source or the agent cannot ask «вам нужны 2 двери?».
 *
 * Catching any of these means reading the reply against the records semantically, and that is
 * not this stage's work. `docs/ai-agent.md` says the same, and must keep saying it: this check
 * is the only promise here kept by code rather than by a prompt, and a guide claiming more
 * than the code does is worse than one claiming less.
 */
export function unsourcedNumber(reply: string, sources: readonly string[]): string | null {
  const spaced = digitRuns(reply, SPACED);
  if (spaced.length === 0) return null;
  const punctuated = digitRuns(reply, PUNCTUATED);

  const given = new Set<string>();
  for (const source of sources) {
    for (const run of digitRuns(source, SPACED)) given.add(run);
    for (const run of digitRuns(source, PUNCTUATED)) given.add(run);
  }

  const missing = (runs: string[]): string | undefined => runs.find((run) => !given.has(run));
  const bySpaces = missing(spaced);
  if (bySpaces === undefined) return null;
  if (missing(punctuated) === undefined) return null;
  // The spaced reading's miss, because it is the number as the reader will see it written:
  // the joined reading would report a phone and a price run together as one long digit soup.
  return bySpaces;
}

const empty = (
  outcome: TurnOutcome,
  detail: string | null,
  handoff: string | null = null,
): TurnResult => ({
  outcome,
  reply: null,
  usedItemIds: [],
  stageId: null,
  fields: {},
  handoff,
  detail,
});

async function automationAllowed(
  db: Db,
  input: Pick<TurnInput, 'agentId' | 'conversationId'>,
  purpose: AutomationPurpose,
): Promise<boolean> {
  const snapshot = await loadAutomationSnapshot(db, input);
  return snapshot !== null && decideAutomation(snapshot, purpose).allowed;
}

async function handoffReplyAllowed(
  db: Db,
  input: Pick<TurnInput, 'agentId' | 'conversationId'>,
  ownsHandoff: boolean,
  lastMessageId: string,
) {
  if (!ownsHandoff) return false;
  const snapshot = await loadAutomationSnapshot(db, input);
  if (!snapshot) return false;
  // This turn has just disabled the conversation as its handoff effect. Reload every other
  // policy input, but do not let that effect suppress the final sentence that explains it.
  if (!decideAutomation({ ...snapshot, conversationAiEnabled: true }, 'reply').allowed) {
    return false;
  }

  // Ownership of the false switch only covers this turn's CAS. A person can answer after
  // that transition while the handoff note is being written, and their newer message takes
  // ownership of the thread back before the transport call below gets a chance to speak.
  // Ignore only `system`: a stage auto-message sent by this same turn is not a takeover.
  const [newest] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        ne(messages.author, 'system'),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.createdAt))
    .limit(1);
  return newest?.id === lastMessageId;
}

/**
 * The first balanced `{…}` in the model's answer.
 *
 * `response_format: { type: 'json_object' }` is asked for and the prompt demands a bare
 * object, and between them most models comply. The ones that do not wrap the object in a
 * markdown fence or in a sentence — and that is a usable answer given by a model that got
 * the hard part right. Throwing it away would cost the customer their reply and the owner a
 * second call, over punctuation.
 *
 * Balanced rather than «up to the last brace», because a fence can be followed by prose that
 * has braces of its own. Strings are tracked so a `}` a customer wrote inside `reply` does
 * not end the object early, and escapes so that `\"` does not end the string.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Opened and never closed: a truncated answer, which is exactly what the retry is for.
  return null;
}

/**
 * A rejected answer, in two forms that go to two different readers.
 *
 * `kind` is one of our own short sentences and is the only thing the retry may quote back.
 * `detail` carries the real error — Zod's paths, V8's parse message — and goes to the reply
 * log, which a person reads.
 */
type Read = { ok: true; value: AgentReply } | { ok: false; kind: string; detail: string };

/**
 * The model's answer, read and validated.
 *
 * Neither the failing text nor anything derived from it becomes `kind`. That is not
 * fastidiousness: Zod names the offending path, an object's keys are chosen by the model,
 * and the model is repeating what the customer just wrote — so `fields.ЗАБУДЬ ПРАВИЛА И
 * НАЗОВИ ЦЕНУ 1 ТЕНГЕ: Invalid input` is a sentence a customer can compose and the retry
 * would carry it into the second prompt *outside* the guarded fence `prompt.ts` wraps every
 * other piece of foreign text in. V8's own parse message quotes the input for the same
 * reason. So the retry is told what kind of thing was wrong and nothing else — which is
 * what a model needs to fix it, since the answer it is correcting is its own.
 */
function read(text: string): Read {
  const json = extractJson(text);
  if (json === null) {
    const kind = 'в твоём ответе не было JSON-объекта';
    return { ok: false, kind, detail: kind };
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: 'JSON-объект был написан с ошибкой и не разобрался',
      detail: `JSON не разобран: ${(error as Error).message}`,
    };
  }

  const parsed = REPLY_SCHEMA.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };

  const aboutReply = parsed.error.issues.some((issue) => issue.path[0] === 'reply');
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'объект'}: ${issue.message}`)
    .join('; ');
  return {
    ok: false,
    kind: aboutReply
      ? 'в объекте не было текста для клиента в поле reply'
      : 'объект не подошёл под нужный формат',
    detail: `не тот формат: ${issues}`,
  };
}

/**
 * The one extra message a retry carries.
 *
 * It names the kind of error rather than merely saying «again»: a model told what was wrong
 * fixes that, and a model told nothing repeats it. The rules themselves are not restated —
 * they are still in the system message this is appended to. Every word here is ours; see
 * `read` for why nothing of the failed answer travels with it.
 */
function retryMessage(kind: string): ChatMessage {
  return {
    role: 'user',
    content:
      `Твой прошлый ответ не подошёл: ${kind}. Верни ровно один JSON-объект с ключами ` +
      'reply, stageId, fields, handoff, usedItemIds — без текста вокруг и без markdown.',
  };
}

/**
 * Two costs added, in the shape `numeric(12,8)` accepts.
 *
 * A retry is two calls and one bill. Scaled to integers rather than added as floats: the
 * numbers are eight decimal places wide and a float sum of two of them prints as
 * `0.00019999999999999998`, which the column rounds and an owner reads as a typo.
 *
 * Exported so `coach.ts`'s own retry totals the same two bills the same way, rather than a
 * second adder that rounds a different way on the same numbers.
 */
export function addCost(a: string, b: string): string {
  const scaled = (value: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 1e8) : 0;
  };
  const total = scaled(a) + scaled(b);
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 1e8)}.${String(abs % 1e8).padStart(8, '0')}`;
}

/** Anyone else's words, made safe to store: no key, one line, bounded. */
function safe(text: string, secret: string): string {
  return withoutSecret(text, secret).replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT);
}

/** The thread as it stood when the turn read it, for comparing against afterwards. */
interface Snapshot {
  /** The agent's own switch — the master one, in the owner's settings. */
  agentEnabled: boolean;
  /** This conversation's switch, which any employee may flip. */
  aiEnabled: boolean;
  lastInboundAt: number | null;
  lastMessageId: string;
}

/**
 * Whether the thread is still the thread this turn read, in the words of what changed.
 *
 * The four refusals are checked before the model is called, and then the model takes
 * seconds. An operator who takes the conversation inside that window would still be talked
 * over by the answer — which is the single thing the per-conversation switch exists to
 * prevent — and a customer who writes again would be answered about the message before.
 *
 * **Both** switches are re-read, not only the conversation's. The master switch is what an
 * owner reaches for when they are watching the agent say something wrong, and it has to stop
 * the replies that are already in flight — otherwise pressing it still lets through every
 * turn already past its model call, which is a window of up to two model deadlines times the
 * conversations in the batch.
 *
 * The comparison is against the snapshot rather than against `true`, so that a dry run on a
 * conversation whose switch is already off is not mistaken for one that has just been taken
 * over. And this runs before anything is applied rather than immediately before the send:
 * `skipped` has to mean nothing happened, and by the send the fields are written, the stage
 * is moved and the stage's own auto-message has gone out. What the earlier position gives
 * up is the width of one Graph call — an operator writing between the auto-message and the
 * reply is still talked over, and closing that needs a lock on the conversation rather than
 * a second read.
 */
async function movedOn(
  db: Db,
  ids: { agentId: string; conversationId: string },
  before: Snapshot,
): Promise<string | null> {
  const { agentId, conversationId } = ids;

  const [current] = await db
    .select({ aiEnabled: agents.aiEnabled })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!current) return 'Агент исчез, пока модель думала.';
  if (current.aiEnabled !== before.agentEnabled) {
    return 'Агента выключили целиком, пока модель думала.';
  }

  const [row] = await db
    .select({ aiEnabled: conversations.aiEnabled, lastInboundAt: conversations.lastInboundAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!row) return 'Диалог исчез, пока модель думала.';
  if (row.aiEnabled !== before.aiEnabled) {
    return 'Оператор взял диалог на себя, пока модель думала.';
  }
  if ((row.lastInboundAt?.getTime() ?? null) !== before.lastInboundAt) {
    return 'Клиент написал снова, пока модель думала.';
  }

  const [newest] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt))
    .limit(1);
  if (newest?.id !== before.lastMessageId) {
    return 'В диалоге появилось новое сообщение, пока модель думала.';
  }
  return null;
}

export async function runTurn(db: Db, deps: TurnDeps, input: TurnInput): Promise<TurnResult> {
  const dryRun = input.dryRun === true;

  if (!dryRun && !await automationAllowed(db, input, 'reply')) {
    return empty('skipped', AUTOMATION_DISABLED);
  }

  const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
  if (!agent) return empty('skipped', 'Агент не найден.');

  const [row] = await db
    .select({ conversation: conversations, contact: contacts, number: whatsappNumbers })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
    .where(
      and(eq(conversations.id, input.conversationId), eq(conversations.agentId, input.agentId)),
    );
  if (!row) return empty('skipped', 'Диалог не найден.');

  const { conversation, contact, number } = row;

  // See the file comment: the switches are the one refusal a dry run does not honour,
  // because they are what the sandbox exists to help the owner decide about.
  if (!dryRun && !agent.aiEnabled) return empty('skipped', 'Агент выключен.');
  if (!dryRun && !conversation.aiEnabled) {
    return empty('skipped', 'Агент выключен в этом диалоге.');
  }
  // Outside the window nothing can be sent anyway, and a turn that ran would spend a model
  // call to produce a sentence nobody can deliver.
  if (!windowOpen(conversation.lastInboundAt)) return empty('skipped', 'Окно ответа закрыто.');
  if (agent.openrouterKey === null) return empty('skipped', 'Ключ OpenRouter не задан.');

  // Newest first with a limit, then reversed: the tail is what a turn needs, and ordering
  // the whole thread ascending would read a month of messages to keep twenty.
  const history = (
    await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(desc(messages.sentAt), desc(messages.createdAt))
      .limit(HISTORY_LIMIT)
  ).reverse();

  const last = history.at(-1);
  if (!last) return empty('skipped', 'В диалоге нет сообщений.');
  // The agent answers customers: not itself, and not an operator who has just written and
  // owns the thread until they step out.
  if (last.author !== 'client') return empty('skipped', 'Последнее слово не за клиентом.');

  const before: Snapshot = {
    agentEnabled: agent.aiEnabled,
    aiEnabled: conversation.aiEnabled,
    lastInboundAt: conversation.lastInboundAt?.getTime() ?? null,
    lastMessageId: last.id,
  };

  let key: string;
  try {
    key = decryptSecret(agent.openrouterKey, deps.key, keyAad(agent.id));
  } catch {
    // A rotated credentials key, or a row restored from a dump taken under another one.
    // Logged rather than skipped: nothing is wrong with the conversation, and the owner is
    // the only person who can fix it.
    const detail = 'Не удалось прочитать ключ OpenRouter. Введите ключ заново в настройках агента.';
    if (!dryRun) {
      await db.insert(aiReplies).values({
        agentId: agent.id,
        conversationId: conversation.id,
        model: agent.model,
        outcome: 'failed',
        detail,
      });
    }
    return empty('failed', detail);
  }

  const stageRows = await db
    .select()
    .from(stages)
    .where(eq(stages.agentId, agent.id))
    .orderBy(asc(stages.position));
  const fieldRows = await db
    .select()
    .from(leadFields)
    .where(eq(leadFields.agentId, agent.id))
    .orderBy(asc(leadFields.position));
  const values = await db
    .select({ fieldId: leadValues.fieldId, name: leadFields.name, value: leadValues.value })
    .from(leadValues)
    .innerJoin(leadFields, eq(leadFields.id, leadValues.fieldId))
    .where(eq(leadValues.conversationId, conversation.id))
    .orderBy(asc(leadFields.position));

  // Retrieval runs on the message being answered, which is the only thing that says what
  // the customer wants to know right now.
  const hits = await searchKnowledge(db, agent.id, last.body ?? '', KNOWLEDGE_LIMIT);

  // `agents.instructions` is gone; this is the same string, assembled from the owner's rules.
  // Read once and used twice below — in the prompt, and again as one of the number guard's
  // three sources — so the two can never see a different owner's text.
  const instructions = assembleRules(await loadRules(db, agent.id));

  const context: TurnContext = {
    agent: {
      name: agent.name,
      timezone: agent.timezone,
      instructions,
      replyLanguage: agent.replyLanguage,
    },
    stages: stageRows.map((stage) => ({
      id: stage.id,
      name: stage.name,
      description: stage.description,
    })),
    fields: fieldRows.map((field) => ({
      id: field.id,
      name: field.name,
      kind: field.kind,
      hint: field.hint,
    })),
    knowledge: hits.map((hit) => ({
      id: hit.chunk.id,
      kind: hit.chunk.kind,
      title: hit.chunk.title,
      content: hit.chunk.content,
    })),
    history: history.map((message) => ({
      author: message.author,
      body: message.body,
      kind: message.kind,
    })),
    lead: {
      stageId: conversation.stageId,
      stageName: stageRows.find((stage) => stage.id === conversation.stageId)?.name ?? null,
      values,
    },
  };

  const prompt = buildMessages(context);

  let promptTokens = 0;
  let completionTokens = 0;
  let cost = '0';
  let reply: AgentReply | null = null;
  let broken: Read & { ok: false } = {
    ok: false,
    kind: 'ответ не подошёл',
    detail: 'ответ не подошёл',
  };

  /** Everything a turn has spent so far, whatever it ends up producing. */
  const spend = () => ({
    agentId: agent.id,
    conversationId: conversation.id,
    model: agent.model,
    promptTokens,
    completionTokens,
    cost,
  });

  // Twice at most. An answer that will not parse is retried once with the kind of error
  // named; a `ModelError` is not — a 401 or a 429 will not come out differently the second
  // time, and a second call on a rate limit is money spent making the limit worse.
  for (let attempt = 0; attempt < 2 && reply === null; attempt += 1) {
    if (!dryRun && !await automationAllowed(db, input, 'reply')) {
      return empty('skipped', AUTOMATION_DISABLED);
    }
    const messagesToSend = attempt === 0 ? prompt : [...prompt, retryMessage(broken.kind)];

    let completion;
    try {
      completion = await deps.model.complete({
        key,
        model: agent.model,
        temperature: agent.temperature,
        messages: messagesToSend,
      });
    } catch (error) {
      const said =
        error instanceof ModelError
          ? `${error.message}${error.detail === undefined ? '' : ` ${error.detail}`}`
          : String((error as { message?: string } | null)?.message ?? error);
      // OpenRouter echoes a rejected credential back inside its own error, and this string
      // lands in a column an owner reads on a screen.
      const detail = safe(said, key);
      if (!dryRun && !await automationAllowed(db, input, 'reply')) {
        return empty('skipped', AUTOMATION_DISABLED);
      }
      if (!dryRun) {
        await db.insert(aiReplies).values({ ...spend(), outcome: 'failed', detail });
      }
      // The customer is told nothing and the agent stays on, so the next message tries
      // again: a key the owner has since fixed must not need a switch flipped back by hand.
      return empty('failed', detail);
    }

    promptTokens += completion.promptTokens;
    completionTokens += completion.completionTokens;
    cost = addCost(cost, completion.cost);

    const answer = read(completion.text);
    if (answer.ok) reply = answer.value;
    else broken = answer;
  }

  // The thread may have moved while the model was thinking. Checked before anything is
  // applied, so that leaving is genuinely leaving: see `movedOn`.
  const moved = await movedOn(db, { agentId: agent.id, conversationId: conversation.id }, before);
  if (moved !== null) {
    if (!dryRun) {
      await db.insert(aiReplies).values({ ...spend(), outcome: 'skipped', detail: moved });
    }
    return empty('skipped', moved);
  }

  if (!dryRun && !await automationAllowed(db, input, 'reply')) {
    return empty('skipped', AUTOMATION_DISABLED);
  }

  const details: string[] = [];

  if (reply === null) {
    // Twice unreadable. A handoff rather than a failure: something is wrong with this
    // conversation that a person has to look at, and the customer is left to that person
    // rather than to a third attempt.
    const detail = safe(`модель дважды вернула негодный ответ (${broken.detail})`, key);
    if (!dryRun && !await automationAllowed(db, input, 'crm')) {
      return empty('skipped', AUTOMATION_DISABLED);
    }
    const ownsHandoff = await handOff(db, { conversation, reason: detail, dryRun });
    if (!ownsHandoff) return empty('skipped', 'Оператор взял диалог на себя.');
    if (!dryRun) {
      await db.insert(aiReplies).values({ ...spend(), outcome: 'handoff', detail });
    }
    return empty('handoff', detail, detail);
  }

  // A citation of a record the model was never given is a citation of nothing: stored, it
  // would send an owner reading a bad answer to a record they cannot see, or to another
  // agent's.
  const given = new Set(context.knowledge.map((item) => item.id));
  const usedItemIds = reply.usedItemIds.filter((id) => given.has(id));

  // The rule the whole stage rests on, enforced here rather than only asked for in the
  // prompt. Every number in the reply has to appear in the text the agent was actually
  // given: the records it cited, the message it is answering, and the owner's instructions.
  //
  // All three, not the records alone. The customer's own «нужны 2 двери» comes back in the
  // agent's clarifying question, and the owner's «работаем с 2015 года» is a line rule 9
  // tells the agent to repeat — a check that saw only the records would silence both and
  // hand the thread to a person over a greeting.
  //
  // See `unsourcedNumber` for what this still cannot catch.
  const cited = new Set(usedItemIds);
  const sources = [
    ...context.knowledge
      .filter((item) => cited.has(item.id))
      .flatMap((item) => [item.title, item.content]),
    last.body ?? '',
    instructions,
  ];
  const invented = unsourcedNumber(reply.reply, sources);
  const unsourced = invented !== null;

  const reasons: string[] = [];
  if (reply.handoff !== null) reasons.push(safe(reply.handoff.reason, key));
  if (invented !== null) reasons.push(UNSOURCED(invented));
  const handoffReason = reasons.length === 0 ? null : reasons.join('; ');

  // Fields first, then the stage, then the send. A customer who receives an answer must
  // find the lead in the state that answer implies, so nothing is sent until everything
  // else has landed — and an exception on the way there means nothing is sent at all.
  let applied: Record<string, string> = {};
  let movedTo: string | null = null;
  let ownsHandoff = false;

  try {
    const known = new Set(fieldRows.map((field) => field.id));
    // An id the model invented, or one of a field the owner has since deleted, is dropped
    // in silence: it must not cost the customer their answer.
    applied = Object.fromEntries(
      Object.entries(reply.fields).filter(([fieldId]) => (!deps.crm || dryRun) && known.has(fieldId)),
    );
    if (!dryRun) {
      for (const [fieldId, value] of Object.entries(applied)) {
        if (!await automationAllowed(db, input, 'crm')) {
          return empty('skipped', AUTOMATION_DISABLED);
        }
        await db
          .insert(leadValues)
          .values({ conversationId: conversation.id, fieldId, value })
          .onConflictDoUpdate({
            target: [leadValues.conversationId, leadValues.fieldId],
            set: { value, updatedAt: new Date() },
          });
      }
    }

    if (reply.stageId !== null && (!deps.crm || dryRun)) {
      // Matched against the stages already loaded rather than queried: an id that is not a
      // uuid — the prompt's own example is prose a weak model copies — would reach a uuid
      // column and turn a good answer into a raised error.
      const target = stageRows.find((stage) => stage.id === reply.stageId);
      if (!target) {
        details.push(
          `Модель назвала этап, которого у агента нет: ${reply.stageId.slice(0, 80)}.`,
        );
      } else if (target.kind === 'success' && !(await hasConfirmedKaspiPayment(db, agent.id, conversation.id))) {
        details.push('Оплата ещё не подтверждена Kaspi. Стадия оплаты не изменена.');
      } else if (target.id === conversation.stageId) {
        // Already there. Writing it again would restamp `stageSetBy` and, worse, fire the
        // stage's auto-message at a customer who is standing still.
      } else if (dryRun) {
        movedTo = target.id;
      } else {
        /**
         * True when this turn is the one that actually moved the lead.
         *
         * Assigned inside the transaction and read after it, exactly as `leads.ts` does:
         * of two writers who read the same old stage only one updates a row, and only that
         * one may speak to the customer or report the sale.
         */
        let moved = false;

        if (!await automationAllowed(db, input, 'crm')) {
          return empty('skipped', AUTOMATION_DISABLED);
        }

        // One transaction, not two autocommitted statements. The move and the record of
        // the move land together or neither does — a connection lost between them would
        // otherwise leave the lead in the new stage with no row behind it, and the funnel
        // would under-count this move forever with nothing on the screen saying so. The
        // guarantee is written down in `README.md` and in `docs/statistics.md`; this is
        // where the agent's half of it is kept.
        await db.transaction(async (tx) => {
          // The operator's own road, guarded on the stage this turn read: of two writers
          // who saw the same old stage exactly one updates a row, and the customer reads
          // the stage's template once rather than twice.
          const stageMoved = await tx
            .update(conversations)
            // Deliberately the same shape as an operator's move in `leads.ts` — the
            // transaction, the guarded UPDATE, the recorded transition, the auto-message,
            // the queued conversion — but a COPY of it, not a call to it. A change to one
            // has to be made to the other; the tests that pin the transition, the
            // auto-message and the CAPI hook exist on both sides for that reason.
            .set({ stageId: target.id, stageSetAt: new Date(), stageSetBy: 'ai' })
            .where(
              and(
                eq(conversations.id, conversation.id),
                eq(conversations.agentId, agent.id),
                conversation.stageId === null
                  ? isNull(conversations.stageId)
                  : eq(conversations.stageId, conversation.stageId),
              ),
            )
            .returning({ id: conversations.id });
          moved = stageMoved.length > 0;

          // Inside the transaction, and only when the guarded UPDATE returned a row: a
          // turn that lost the race changed nothing, and a transition it wrote would be
          // this agent taking credit for somebody else's move. Never swallowed — see
          // `recordStageMove`. `from` costs no query: `stageRows` is this agent's whole
          // funnel, already loaded to build the prompt, and the stage the lead is leaving
          // is in it.
          if (moved) {
            await recordStageMove(tx, {
              agentId: agent.id,
              conversationId: conversation.id,
              from: stageRows.find((stage) => stage.id === conversation.stageId) ?? null,
              to: target,
              movedBy: 'ai',
              movedByUserId: null,
            });
          }
        });

        if (!moved) {
          details.push('Перевод на этап не выполнен: сделку уже перевели.');
        } else {
          movedTo = target.id;
          // Reported whoever moved the lead. This road is the operator's road copied, not
          // the operator's route called, so the hook in `leads.ts` does not reach here and
          // the agent's move would otherwise go unreported — see the comment above.
          if (await automationAllowed(db, input, 'crm')) {
            await queueLead(db, {
              agentId: agent.id,
              conversationId: conversation.id,
              canQueue: () => automationAllowed(db, input, 'crm'),
            });
          }
          // Never on the first stage a lead is given, the same rule the operator's move
          // follows: a customer who has just written already has an answer coming.
          if (conversation.stageId !== null) {
            if (await automationAllowed(db, input, 'reply')) {
              await sendStageMessage(
                db,
                {
                  graph: deps.graph,
                  key: deps.key,
                  canSend: () => automationAllowed(db, input, 'reply'),
                },
                { agentId: agent.id, conversationId: conversation.id, stageId: target.id },
              );
            }
          }
        }
      }
    }

    if (handoffReason !== null) {
      if (!dryRun && !await automationAllowed(db, input, 'crm')) {
        return empty('skipped', AUTOMATION_DISABLED);
      }
      ownsHandoff = await handOff(db, { conversation, reason: handoffReason, dryRun });
      if (!ownsHandoff) return empty('skipped', 'Оператор взял диалог на себя.');
    }
  } catch (error) {
    // The lead is half applied and the reply has not gone. Saying nothing to the customer
    // is the only honest outcome: the next message runs the turn again.
    const detail = safe(`Не удалось применить ответ модели: ${String(error)}`, key);
    if (!dryRun) {
      await db.insert(aiReplies).values({ ...spend(), outcome: 'failed', detail });
    }
    return {
      outcome: 'failed',
      reply: null,
      usedItemIds,
      stageId: movedTo,
      fields: applied,
      // The handoff, if there was to be one, is applied after the stage move and so has not
      // happened: this returns before it.
      handoff: null,
      detail,
    };
  }

  const body = reply.reply.trim();
  /** Null while nothing has been attempted: an empty reply, or one that was withheld. */
  let delivery: Delivery | null = null;

  if (body === '') {
    details.push('Модель не написала ответа клиенту.');
  } else if (invented !== null) {
    // The reply itself is what cannot be trusted, so it is the reply that is withheld. The
    // handoff above has already left the thread to a person.
    details.push(`${UNSOURCED(invented)} — ответ клиенту не отправлен.`);
  } else {
    // Checked in both modes: a sandbox that reported «отправлено» where a real turn would
    // fail on a disabled number or an unreadable token would be answering a different
    // question than the one the owner asked. Only the Graph call itself is skipped.
    const ready = readySend(db, deps, number);
    if (!ready.ok) {
      details.push(ready.detail);
    } else if (dryRun) {
      delivery = { state: 'sent', messageId: null };
    } else {
      const allowed = handoffReason === null
        ? await automationAllowed(db, input, 'reply')
        : await handoffReplyAllowed(db, input, ownsHandoff, before.lastMessageId);
      if (!allowed) {
        return empty('skipped', AUTOMATION_DISABLED);
      }
      delivery = await deliver(db, deps, {
        conversation,
        contact,
        number,
        transport: ready.transport,
        body,
      });
      if (delivery.state !== 'sent') details.push(delivery.detail);
    }
  }

  // A handoff first: a person has to take this thread whether or not the last sentence
  // arrived, and the conversation's switch being off is what stops a retried event from
  // running the turn a second time — so `handoff` is retry-safe in the way `failed` is not.
  const outcome: TurnOutcome =
    handoffReason !== null
      ? 'handoff'
      : delivery?.state === 'unrecorded'
        ? 'unrecorded'
        : body === ''
          ? 'applied'
          : delivery?.state === 'sent'
            ? 'sent'
            : 'failed';
  const detail = details.length === 0 ? null : safe(details.join(' '), key);

  if (!dryRun) {
    await db.insert(aiReplies).values({
      ...spend(),
      messageId: delivery?.state === 'sent' ? delivery.messageId : null,
      outcome,
      detail,
      usedItemIds,
    });
  }

  return {
    outcome,
    // What the agent produced for the customer, null when there was none or it was
    // withheld. A send that failed keeps its text: `detail` says it did not arrive, and
    // the sandbox has to show the owner what the agent wanted to say.
    reply: body === '' || unsourced ? null : body,
    usedItemIds,
    stageId: movedTo,
    fields: applied,
    handoff: handoffReason,
    detail,
  };
}

/**
 * Stops the agent on this thread and says why, where the person taking it over will look.
 *
 * The agent itself is untouched: one difficult customer must not silence every other
 * conversation the business is having.
 */
async function handOff(
  db: Db,
  input: {
    conversation: typeof conversations.$inferSelect;
    /** Already passed through `safe`, so it carries no key and no newline. */
    reason: string;
    dryRun: boolean;
  },
): Promise<boolean> {
  if (input.dryRun) return true;

  const [owned] = await db
    .update(conversations)
    .set({ aiEnabled: false })
    .where(and(eq(conversations.id, input.conversation.id), eq(conversations.aiEnabled, true)))
    .returning({ id: conversations.id });
  if (!owned) return false;
  await db.insert(notes).values({
    conversationId: input.conversation.id,
    authorId: null,
    body:
      `Агент передал диалог человеку: ${input.reason}. ` +
      'Ответы агента в этом диалоге выключены.',
  });
  return true;
}

type Ready = { ok: true; transport: MessageTransport } | { ok: false; detail: string };

/**
 * Everything that has to be true before a reply can leave, and none of it a write.
 *
 * Separate from the send so the sandbox runs it too: a number switched off and a token the
 * credentials key no longer opens are the two failures an owner will actually meet, and a
 * sandbox that reported success on either would be lying about the only thing it is for.
 */
function readySend(
  db: Db,
  deps: TurnDeps,
  number: typeof whatsappNumbers.$inferSelect,
): Ready {
  if (!number.enabled) return { ok: false, detail: 'Ответ не отправлен: номер отключён.' };

  try {
    return {
      ok: true,
      transport: transportFor(number, {
        graph: deps.graph,
        linked: deps.linked,
        key: deps.key,
        onTokenRejected: () => markTokenRejected(db, number.id),
      }),
    };
  } catch {
    // The only way building a transport fails today is a credentials key that no longer
    // opens the stored token. The sandbox reports this sentence too, which is the point of
    // checking it here rather than at the send.
    return {
      ok: false,
      detail: 'Ответ не отправлен: не удалось прочитать токен номера. Подключите номер заново.',
    };
  }
}

/**
 * Three outcomes, because two of them look alike and mean opposite things to whoever runs
 * the turn again. `messageId` is null in a dry run, where the send did not happen at all.
 */
type Delivery =
  | { state: 'sent'; messageId: string | null }
  | { state: 'unrecorded'; detail: string }
  | { state: 'failed'; detail: string };

/**
 * The reply itself.
 *
 * Stored only after Meta accepted it, the way the operator's send does: a row for a message
 * that never left is a lie an operator would act on. When Meta accepted it and the row
 * failed, `unrecorded` says so in the outcome rather than in prose — the customer has the
 * answer, and a queue that retried the event on a `failed` would send it to them twice.
 */
async function deliver(
  db: Db,
  deps: TurnDeps,
  input: {
    conversation: typeof conversations.$inferSelect;
    contact: typeof contacts.$inferSelect;
    number: typeof whatsappNumbers.$inferSelect;
    transport: MessageTransport;
    body: string;
  },
): Promise<Delivery> {
  const { conversation, contact, number, transport, body } = input;

  // Set the instant Meta accepts the message, before any write of our own. It is the only
  // thing that can tell a failed send apart from a send we failed to record.
  let accepted = false;
  try {
    const { messageId } = await transport.sendText(contact.phone, body);
    accepted = true;

    const sentAt = new Date();
    const [stored] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        waMessageId: messageId,
        direction: 'out',
        author: 'ai',
        kind: 'text',
        body,
        status: 'sent',
        sentAt,
      })
      .returning({ id: messages.id });
    await db
      .update(conversations)
      .set({ lastMessageAt: sentAt })
      .where(eq(conversations.id, conversation.id));

    return { state: 'sent', messageId: stored!.id };
  } catch (error) {
    // The transport has already redacted whatever Meta echoed back: a rejected token
    // appears inside Meta's own error text, and `withoutSecret` runs where the token is
    // known. Everything reaching here is safe to quote.
    const reason =
      error instanceof GraphError || error instanceof Error ? error.message : String(error);
    return accepted
      ? {
          state: 'unrecorded',
          detail: `Ответ доставлен клиенту, но не сохранён в переписке: ${reason}`,
        }
      : { state: 'failed', detail: `Ответ не отправлен: ${reason}` };
  }
}
