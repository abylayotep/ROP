import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  contacts,
  conversations,
  messages,
  whatsappEvents,
  whatsappNumbers,
} from '../../db/schema.js';
import type { ModelClient } from '../ai/openrouter.js';
import { runTurn } from '../ai/turn.js';
import { decryptSecret } from '../secret-box.js';
import { asCloudNumber } from './cloud-number.js';
import { withoutSecret, type GraphClient } from './graph.js';
import { applyHistory, type HistoryValue } from './history.js';
import { downloadInboundMedia } from './media.js';

/**
 * Turning stored webhook deliveries into rows.
 *
 * A function over pending events rather than code inside the route, for three reasons: the
 * route can answer Meta before any of this runs, the tests can drive it without HTTP, and a
 * delivery that failed to parse can be run again once the bug is fixed.
 */

export interface InboundDeps {
  graph: GraphClient;
  /** Decrypts a number's access token; media downloads and the agent's own send need it. */
  key: Buffer;
  mediaDir: string;
  /**
   * The agent answers here, once the messages of a delivery are stored. Meta has already had
   * its 200 by then, so a model that thinks for a minute cannot make it retry the webhook.
   */
  model: ModelClient;
}

/** The referral block Meta attaches to the first message of a click-to-WhatsApp conversation. */
interface Referral {
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

/** The slice of Meta's payload this stage reads. Everything else is ignored on purpose. */
interface InboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
  referral?: Referral;
}

interface StatusUpdate {
  id: string;
  status: string;
}

/** A message the operator sent from the WhatsApp Business app. Same fields as inbound plus `to`. */
interface EchoMessage extends InboundMessage {
  to?: string;
}

interface ContactSync {
  type: string;
  action: 'add' | 'remove';
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
}

interface ChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: InboundMessage[];
  statuses?: StatusUpdate[];
  message_echoes?: EchoMessage[];
  state_sync?: ContactSync[];
}

/** The number a delivery arrived on, as it is stored. */
type NumberRow = typeof whatsappNumbers.$inferSelect;

/** WhatsApp sends seconds; Postgres wants a Date. */
const at = (timestamp: string) => new Date(Number(timestamp) * 1000);

/**
 * The text a message carries, if it carries any. A caption counts.
 *
 * Keyed on the declared `type` rather than checking each field's presence: Meta only ever
 * populates the sub-object matching `type`, and reading by type is what keeps an unrenderable
 * kind (location, contacts, unsupported) from picking up text that belongs to a different field.
 */
function bodyOf(message: InboundMessage): string | null {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? null;
    case 'image':
      return message.image?.caption ?? null;
    case 'video':
      return message.video?.caption ?? null;
    case 'document':
      return message.document?.caption ?? null;
    default:
      return null;
  }
}

/** The media id a message carries, if it carries one. */
function mediaIdOf(message: InboundMessage): string | null {
  return (
    message.image?.id ??
    message.audio?.id ??
    message.video?.id ??
    message.document?.id ??
    message.sticker?.id ??
    null
  );
}

/** Rows a delivery will not be retried past. Five is generous for a transient fault. */
const MAX_ATTEMPTS = 5;

/** How many events one pass takes. A webhook delivery must not turn into a long job. */
const BATCH = 50;

/** A claimed event. Raw SQL, so the columns arrive under their database names. */
interface ClaimedEvent {
  id: string;
  payload: unknown;
  received_at: Date;
}

/**
 * The rows out of a `db.execute` result.
 *
 * The driver decides the shape: postgres-js hands back the rows as an array, node-postgres
 * wraps them in an object. Reading both means this does not break on a driver swap.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function processPendingEvents(
  db: Db,
  deps: InboundDeps,
): Promise<{ processed: number; failed: number }> {
  // A claim, not a select: one statement takes a batch and counts the attempt before any
  // of the work starts. Counting it here is what eventually retires an event that always
  // throws — otherwise it is retried forever and every later pass has to walk past it.
  //
  // `for update skip locked` keeps two claims that land in the same instant off each
  // other's rows. It does not reserve a row for the duration of its processing: this
  // statement autocommits, so the locks are gone the moment it returns, long before the
  // row is processed and stamped. Two passes a hundred milliseconds apart can therefore
  // both take the same event — the second one finds it still unprocessed and unlocked.
  //
  // That is harmless, because every write below is idempotent: the message insert dedupes
  // on the unique index, both upserts are conflict-safe, a media file is rewritten to the
  // same path, and the timestamp update is a `greatest`. The cost is a duplicated download
  // and an attempt burned twice. Real exclusivity would need a `processing_at` column or a
  // transaction spanning the whole of the work; neither is here.
  //
  // What keeps that window narrow is that `processed_at` is stamped as soon as the messages
  // are stored, before the agent's turns run. A turn is minutes wide; storing a delivery is
  // milliseconds.
  const claimed = await db.execute(sql`
    update whatsapp_events
       set attempts = attempts + 1
     where id in (
       select id from whatsapp_events
        where processed_at is null and attempts < ${MAX_ATTEMPTS}
        order by received_at
        limit ${BATCH}
        for update skip locked
     )
    returning *
  `);
  // `returning` gives no order of its own — the `order by` above only chooses which rows
  // the batch takes. Arrival order has to hold here, because the first referral on a
  // conversation is the one kept and the last name seen is the one stored.
  const pending = rowsOf<ClaimedEvent>(claimed).sort(
    (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime(),
  );

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    let applied: Applied;
    try {
      applied = await applyPayload(db, deps, event.payload);
    } catch (error) {
      // The row keeps its payload and gains a reason. One bad delivery must not stop the
      // queue: the next message in line is someone's live conversation.
      await db
        .update(whatsappEvents)
        .set({ error: error instanceof Error ? error.message : String(error) })
        .where(eq(whatsappEvents.id, event.id));
      failed += 1;
      continue;
    }

    // Stamped the moment the messages are stored, and **before** the turns run.
    //
    // A turn takes up to two model deadlines — two minutes — and while `processed_at` is
    // null the event is still claimable. Every webhook arriving inside that window started a
    // pass that claimed this event again and burned an attempt; five of those and a restart
    // retired the event with the customer's message neither stored nor answered, in silence.
    // Before the agent existed the window was milliseconds wide, which is why the claim was
    // written to tolerate it.
    //
    // Stamping first rather than holding a claim across the turn, because the turn is
    // already built to survive being abandoned: it runs exactly once per stored message
    // (`storeMessage` says which messages this pass stored, from the insert itself), and
    // `runTurns` treats no outcome as a reason to fail the event. A lease that outlived the
    // turn would need a column, an expiry, and a decision about what to do with a lease held
    // by a process that has died — all to protect work that is not retried anyway.
    await db
      .update(whatsappEvents)
      .set({
        processedAt: new Date(),
        error: applied.errors.length ? applied.errors.join('; ') : null,
      })
      .where(eq(whatsappEvents.id, event.id));
    processed += 1;

    // Never throws; see `runTurns`. Its errors land on the row that is already processed,
    // beside the media downloads', because they are worth reading and not worth retrying.
    const turnErrors = await runTurns(db, deps, applied.touched);
    if (turnErrors.length > 0) {
      const all = [...applied.errors, ...turnErrors];
      await db
        .update(whatsappEvents)
        .set({ error: all.join('; ') })
        .where(eq(whatsappEvents.id, event.id));
    }
  }

  return { processed, failed };
}

/**
 * Every conversation a delivery put a new message on, and the agent it belongs to.
 *
 * A map rather than a list, because one turn per conversation is the whole point: a customer
 * who sends three lines in one delivery is asking one question and gets one answer.
 */
type Touched = Map<string, string>;

/**
 * What one delivery left behind: what went wrong storing it, and who now owes an answer.
 *
 * The two are separated because they happen at different times. The errors belong on the
 * event as it is stamped processed; the conversations are answered afterwards, once the
 * event can no longer be claimed by a pass that arrives while the model is thinking.
 */
interface Applied {
  /** Media download errors collected while applying the payload, if any. */
  errors: string[];
  touched: Touched;
}

async function applyPayload(db: Db, deps: InboundDeps, payload: unknown): Promise<Applied> {
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) throw new Error('entry is not an array');

  const errors: string[] = [];
  const touched: Touched = new Map();
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) throw new Error('changes is not an array');

    for (const change of changes) {
      const { field, value } = change as { field?: string; value?: ChangeValue };
      if (field === 'account_update') {
        const wabaId = (entry as { id?: string }).id;
        if (wabaId) await applyAccountUpdate(db, wabaId, (value ?? {}) as AccountUpdateValue);
        continue;
      }
      errors.push(...(await applyChange(db, deps, field ?? 'messages', value ?? {}, touched)));
    }
  }
  // The turns are the caller's to run, after this delivery is stamped processed — and after
  // every message of it is stored, so a turn reads the whole of what the customer just said
  // and answers the last line rather than the first.
  return { errors, touched };
}

/**
 * The agent's answer to what this delivery brought, one turn per conversation.
 *
 * Nothing here may throw. This runs after the event is stamped processed, so an exception
 * escaping it would not lose the customer's message — but it would abandon the turns of
 * every conversation after this one in the batch. A retry is the one thing a turn cannot
 * survive: `unrecorded` means Meta accepted the reply and only our own row failed, so
 * running the turn again would send the customer the same sentence twice. Hence a turn runs
 * exactly once per stored message, a redelivered message is not a stored message, and an
 * outcome is never a reason to fail the event. Only a raised error is worth writing down,
 * and it goes where the media download's does: onto the event, which is already processed.
 */
async function runTurns(db: Db, deps: InboundDeps, touched: Touched): Promise<string[]> {
  const errors: string[] = [];
  for (const [conversationId, agentId] of touched) {
    try {
      const turnDeps = { model: deps.model, graph: deps.graph, key: deps.key };
      await runTurn(db, turnDeps, { agentId, conversationId });
    } catch (error) {
      // One conversation's failure must not cost the others theirs: the next entry in the
      // map is somebody else's live thread.
      errors.push(
        `ответ агента не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

/**
 * Records the ad a conversation came from, once.
 *
 * Meta puts `referral` on the first message of a click-to-WhatsApp conversation and never
 * again, and `ctwa_clid` inside it is what stage 6 matches a purchase against — there is no
 * way to look it up afterwards. The `referral_seen_at is null` condition is what makes this
 * write-once: a later ad must not overwrite the one that actually paid for this client.
 *
 * A referral without a click id is still worth keeping: it names the ad for a human reading
 * the conversation, even though Meta cannot attribute a purchase to it.
 */
async function recordReferral(
  db: Db,
  conversationId: string,
  referral: Referral,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      ctwaClid: referral.ctwa_clid ?? null,
      adSourceId: referral.source_id ?? null,
      adSourceType: referral.source_type ?? null,
      adHeadline: referral.headline ?? null,
      adBody: referral.body ?? null,
      referralSeenAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.referralSeenAt)));
}

/** The `account_update` payload, which speaks about the WABA rather than about a phone. */
interface AccountUpdateValue {
  event?: string;
  disconnection_info?: { reason?: string; initiated_by?: string };
}

/**
 * Meta's word on whether the phone still lets us in.
 *
 * Coexistence has no deregister call: the owner disconnects on the phone, Meta tells us
 * here, and until they reconnect every send would fail. Disabling the number keeps the
 * cabinet honest — the composer says why — and the row, with its conversations and click
 * ids, stays for when they come back. Every number on the WABA is affected: the event is
 * about the account, not one phone.
 *
 * The manual-kind filter keeps a pasted-token number on the same WABA untouched: Meta's
 * offboard event is about the phone's companion, not about the system-user token.
 */
async function applyAccountUpdate(
  db: Db,
  wabaId: string,
  value: AccountUpdateValue,
): Promise<void> {
  switch (value.event) {
    case 'PARTNER_REMOVED':
    case 'ACCOUNT_OFFBOARDED':
      await db
        .update(whatsappNumbers)
        // `coalesce` so a redelivered offboard keeps the moment it first happened.
        .set({ enabled: false, offboardedAt: sql`coalesce(${whatsappNumbers.offboardedAt}, now())` })
        .where(
          and(
            eq(whatsappNumbers.wabaId, wabaId),
            eq(whatsappNumbers.connectionKind, 'coexistence'),
          ),
        );
      return;
    case 'ACCOUNT_RECONNECTED':
      await db
        .update(whatsappNumbers)
        .set({ enabled: true, offboardedAt: null })
        .where(
          and(
            eq(whatsappNumbers.wabaId, wabaId),
            eq(whatsappNumbers.connectionKind, 'coexistence'),
          ),
        );
      return;
    default:
      // Verification, name and tier changes all arrive here. None of them change our access.
      return;
  }
}

/**
 * Which handler a change belongs to, by the field Meta named it with.
 *
 * A coexistence number is subscribed to more than `messages`: the phone's own sends and its
 * address book arrive under their own fields, in the same envelope.
 */
async function applyChange(
  db: Db,
  deps: InboundDeps,
  field: string,
  value: ChangeValue,
  touched: Touched,
): Promise<string[]> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return [];

  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

  // Not an error: one Meta application serves every client, and a delivery about a number
  // we do not host is simply not ours.
  if (!number) return [];

  switch (field) {
    case 'messages':
      return applyMessages(db, deps, number, value, touched);
    case 'smb_message_echoes':
      return applyEchoes(db, deps, number, value.message_echoes ?? []);
    case 'smb_app_state_sync':
      await applyContactSync(db, number.agentId, value.state_sync ?? []);
      return [];
    case 'history': {
      // `ChangeValue` and `HistoryValue` overlap on `metadata`; the cast is honest.
      const { errors } = await applyHistory(db, deps, number, value as HistoryValue);
      return errors;
    }
    default:
      // A field we did not subscribe to, or one a later stage will handle. Stored already;
      // nothing to do.
      return [];
  }
}

/** Returns the media download errors collected while applying this change, if any. */
async function applyMessages(
  db: Db,
  deps: InboundDeps,
  number: NumberRow,
  value: ChangeValue,
  touched: Touched,
): Promise<string[]> {
  for (const status of value.statuses ?? []) {
    await db
      .update(messages)
      .set({ status: status.status })
      .where(
        and(
          eq(messages.waMessageId, status.id),
          // Global uniqueness makes the id alone safe today, but the delivery arrived on
          // one number and may only speak for the threads on that number.
          inArray(
            messages.conversationId,
            db
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.whatsappNumberId, number.id)),
          ),
        ),
      );
  }

  const errors: string[] = [];
  for (const incoming of value.messages ?? []) {
    const profileName = value.contacts?.find((c) => c.wa_id === incoming.from)?.profile?.name;
    const contactId = await upsertContact(db, number.agentId, incoming.from, profileName);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    // Meta redelivers the same message by design. The insert below would drop the
    // duplicate anyway, so downloading its file a second time is pure waste — a Graph
    // call and a full transfer for bytes already on disk.
    const [known] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.waMessageId, incoming.id));

    let media: { path: string; mime: string } | null = null;
    const mediaId = mediaIdOf(incoming);
    if (mediaId && !known) {
      let token = '';
      try {
        // Decrypted inside the try, on purpose: a key that no longer matches — rotated,
        // or a row someone edited — must cost this one message its file, not abort the
        // whole delivery. `withoutSecret` with an empty secret returns the message
        // unchanged, which is right: there is no token to hide when decryption itself
        // is what failed.
        const cloud = asCloudNumber(number);
        token = decryptSecret(cloud.accessToken, deps.key, cloud.phoneNumberId);
        media = await downloadInboundMedia(deps, {
          mediaId,
          token,
          agentId: number.agentId,
          waMessageId: incoming.id,
        });
      } catch (error) {
        // The message is still worth having: its caption, its sender and its place in the
        // thread are all real. Only the file is missing, and the event says why.
        errors.push(
          withoutSecret(error instanceof Error ? error.message : String(error), token),
        );
      }
    }

    // Only a message this pass actually stored earns an answer, and `storeMessage` says so
    // from the insert itself rather than from the read above. Meta redelivers by design and
    // two passes can claim one event, so the unique index is the only thing that can tell
    // «we stored it» from «somebody already had it» — and the customer already has the
    // reply to the copy that was stored first.
    //
    // What this gives up: if something below throws after the message is stored, the event
    // is retried, the message is `known` by then, and that one line is never answered. The
    // alternative — answering a known message on a retry — cannot be made safe, because the
    // reply may already have gone out and only its row have failed (`unrecorded` in
    // `TurnResult`), and answering twice is worse for the customer than answering once late.
    // The customer's next message runs a turn on the whole thread, which is how the missed
    // line is picked up; a customer who never writes again was leaving anyway.
    if (!known && (await storeMessage(db, conversationId, incoming, media))) {
      touched.set(conversationId, number.agentId);
    }
    if (incoming.referral) await recordReferral(db, conversationId, incoming.referral);

    const sentAt = at(incoming.timestamp);
    // Bound as an ISO string with an explicit cast, not as a Date: a Date inlined into a
    // `sql` fragment reaches Postgres as an untyped parameter and `greatest` cannot be
    // resolved against it, which fails the whole delivery.
    const sentAtParam = sql`${sentAt.toISOString()}::timestamptz`;
    await db
      .update(conversations)
      .set({
        // Both columns only ever move forward. Meta redelivers, sometimes out of order:
        // lastInboundAt going backwards would refuse an operator a reply they are
        // entitled to send, and lastMessageAt going backwards would reorder the list
        // under someone who is reading it. Guarded per column rather than in a where
        // clause, because an operator's reply moves lastMessageAt on its own.
        lastInboundAt: sql`greatest(coalesce(${conversations.lastInboundAt}, to_timestamp(0)), ${sentAtParam})`,
        lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${sentAtParam})`,
      })
      .where(eq(conversations.id, conversationId));
  }
  return errors;
}

/** Digits only, the shape `wa_id` uses. Meta's contact sync sends `+7 777 …` with spaces. */
const digits = (phone: string) => phone.replace(/\D/g, '');

/**
 * What the operator said from the phone. Stored so the thread in the cabinet is whole, and
 * treated as the operator taking the thread: the agent stops answering here until someone in
 * the cabinet turns it back on. No turn runs — a customer was just answered by a human.
 *
 * `last_inbound_at` is not touched: an app-sent message does not open a reply window, and
 * pretending it did would let the cabinet send a free-form reply Meta will refuse.
 */
async function applyEchoes(
  db: Db,
  deps: InboundDeps,
  number: NumberRow,
  echoes: EchoMessage[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const echo of echoes) {
    // Meta always names the recipient; a delivery that does not is malformed. There is no
    // thread to file it under, so it is written down and skipped rather than thrown — one
    // bad echo must not cost the whole delivery.
    const to = digits(echo.to ?? '');
    if (!to || !echo.id) {
      errors.push('эхо без адресата пропущено');
      continue;
    }
    const contactId = await upsertContact(db, number.agentId, to, undefined);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    const [known] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.waMessageId, echo.id));

    let media: { path: string; mime: string } | null = null;
    const mediaId = mediaIdOf(echo);
    if (mediaId && !known) {
      let token = '';
      try {
        const cloud = asCloudNumber(number);
        token = decryptSecret(cloud.accessToken, deps.key, cloud.phoneNumberId);
        media = await downloadInboundMedia(deps, {
          mediaId,
          token,
          agentId: number.agentId,
          waMessageId: echo.id,
        });
      } catch (error) {
        errors.push(
          withoutSecret(error instanceof Error ? error.message : String(error), token),
        );
      }
    }

    const stored = await db
      .insert(messages)
      .values({
        conversationId,
        waMessageId: echo.id,
        direction: 'out',
        author: 'phone',
        kind: echo.type,
        body: bodyOf(echo),
        status: 'sent',
        sentAt: at(echo.timestamp),
        mediaPath: media?.path ?? null,
        mediaMime: media?.mime ?? null,
      })
      .onConflictDoNothing({ target: messages.waMessageId })
      // Empty when the conflict fired, which is what tells a first delivery from a redelivery.
      .returning({ id: messages.id });

    const sentAtParam = sql`${at(echo.timestamp).toISOString()}::timestamptz`;
    await db
      .update(conversations)
      .set({
        // Only ever forward, and a `greatest`, so a redelivery costs nothing.
        lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${sentAtParam})`,
      })
      .where(eq(conversations.id, conversationId));

    // Switching the agent off is the operator taking the thread, and that happens once — on
    // the delivery that actually stored this echo. Meta redelivers by design, and doing it
    // again would silence a thread the operator has since re-enabled in the cabinet.
    if (stored.length > 0) {
      await db
        .update(conversations)
        .set({ aiEnabled: false })
        .where(eq(conversations.id, conversationId));
    }
  }
  return errors;
}

/**
 * The phone's address book, as Meta streams it after onboarding and on every edit.
 *
 * `add` covers edits too. A name typed in the cabinet wins over the phone-book entry, so the
 * upsert fills only a null name. `remove` changes nothing: the person may still write, and
 * what they said is ours to keep.
 */
async function applyContactSync(db: Db, agentId: string, items: ContactSync[]): Promise<void> {
  for (const item of items) {
    if (item.type !== 'contact' || item.action !== 'add') continue;
    const phone = digits(item.contact?.phone_number ?? '');
    if (!phone) continue;
    const name = item.contact?.full_name?.trim() || item.contact?.first_name?.trim() || null;
    await db
      .insert(contacts)
      .values({ agentId, phone, name })
      .onConflictDoUpdate({
        target: [contacts.agentId, contacts.phone],
        set: { name: sql`coalesce(${contacts.name}, ${name})` },
      });
  }
}

async function upsertContact(
  db: Db,
  agentId: string,
  phone: string,
  name: string | undefined,
): Promise<string> {
  const [created] = await db
    .insert(contacts)
    .values({ agentId, phone, name: name ?? null })
    .onConflictDoUpdate({
      target: [contacts.agentId, contacts.phone],
      // A person who edits their WhatsApp profile should be renamed here too, but a
      // delivery without a name must not erase the one we have.
      set: name ? { name } : { phone },
    })
    .returning({ id: contacts.id });
  return created!.id;
}

async function upsertConversation(
  db: Db,
  agentId: string,
  whatsappNumberId: string,
  contactId: string,
): Promise<string> {
  const [created] = await db
    .insert(conversations)
    .values({ agentId, contactId, whatsappNumberId })
    .onConflictDoUpdate({
      target: [conversations.whatsappNumberId, conversations.contactId],
      set: { contactId },
    })
    .returning({ id: conversations.id });
  return created!.id;
}

/** True when this call is the one that stored the message, false when it was already there. */
async function storeMessage(
  db: Db,
  conversationId: string,
  incoming: InboundMessage,
  media: { path: string; mime: string } | null,
): Promise<boolean> {
  const stored = await db
    .insert(messages)
    .values({
      conversationId,
      waMessageId: incoming.id,
      direction: 'in',
      author: 'client',
      kind: incoming.type,
      body: bodyOf(incoming),
      sentAt: at(incoming.timestamp),
      mediaPath: media?.path ?? null,
      mediaMime: media?.mime ?? null,
    })
    // Meta delivers the same message more than once by design. The unique index on
    // wa_message_id is the defence; this clause is how we accept the duplicate quietly.
    .onConflictDoNothing({ target: messages.waMessageId })
    // Empty when the conflict fired, which is what makes the answer above trustworthy.
    .returning({ id: messages.id });
  return stored.length > 0;
}
