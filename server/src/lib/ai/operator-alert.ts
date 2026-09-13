/**
 * The WhatsApp message a person gets when the agent hands a conversation to them.
 *
 * The handoff itself — the switch turned off, the note on the conversation — is `turn.ts`'s,
 * and it is complete without this. The note only helps someone who is already looking at the
 * cabinet; this is what makes them look. So everything here is best-effort by construction:
 * nothing it does may fail, retry or change a turn, and a send that did not go through is
 * written down as a note on the same conversation instead of being raised.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  agents,
  contacts,
  conversations,
  leadFields,
  leadValues,
  notes,
  whatsappNumbers,
} from '../../db/schema.js';
import { markTokenRejected } from '../whatsapp/token-expiry.js';
import { transportFor } from '../whatsapp/transport.js';
import type { TurnDeps } from './turn.js';

export type OperatorPhone = { ok: true; phone: string | null } | { ok: false; message: string };

/**
 * An operator phone as the owner typed it, in the digits-only form contacts are stored in.
 *
 * The same two local spellings `conversations.ts` already reads in its phone search: `8 771…`
 * is how a Kazakhstani or Russian number is written at home and `7 771…` is the same number
 * dialled internationally, and a bare ten digits is that number without its country code.
 * Stored this way so the «operator is the client» check in the send is one string comparison
 * against `contacts.phone`, and so the linked socket's echo can be recognised the same way.
 */
export function normalizeOperatorPhone(raw: string): OperatorPhone {
  if (raw.trim() === '') return { ok: true, phone: null };
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('7')) digits = `7${digits}`;
  if (digits.length < 10 || digits.length > 15) {
    return { ok: false, message: 'Укажите номер WhatsApp в международном формате, например +7 771 694 44 99' };
  }
  return { ok: true, phone: digits };
}

export interface OperatorAlertInput {
  urgent: boolean;
  contactName: string | null;
  contactPhone: string | null;
  /** Filled lead fields, already in `lead_fields.position` order. */
  values: readonly { name: string; value: string }[];
  summary: string;
  reason: string;
  channel: 'whatsapp' | 'instagram';
}

/** A WhatsApp text is allowed far more, but past this it stops being a glance. */
export const ALERT_LIMIT = 1000;
const VALUE_LIMIT = 200;

/** Anyone's text on one line and bounded: a client's field value may hold newlines. */
function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The alert text. Pure, so its shape is tested without a database or a socket.
 *
 * A line with nothing to say is left out rather than printed empty: «Что хочет: » tells the
 * operator less than no line at all, and the twice-unreadable handoff has no summary to give.
 */
export function formatOperatorAlert(input: OperatorAlertInput): string {
  const lines = [
    input.urgent ? 'СРОЧНО — нужен оператор' : 'Нужен оператор',
    `Клиент: ${clip(input.contactName ?? '', VALUE_LIMIT) || 'без имени'}`,
  ];
  if (input.contactPhone) lines.push(`Телефон: +${clip(input.contactPhone, 20)}`);
  for (const { name, value } of input.values) {
    const shown = clip(value, VALUE_LIMIT);
    if (shown !== '') lines.push(`${clip(name, 60)}: ${shown}`);
  }
  const summary = clip(input.summary, 300);
  if (summary !== '') lines.push(`Что хочет: ${summary}`);
  const reason = clip(input.reason, 300);
  if (reason !== '') lines.push(`Причина: ${reason}`);
  lines.push(`Канал: ${input.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}`);

  // Cut from the end as a last resort: the header, the client and the phone come first, and
  // they are what the operator needs to act at all.
  const text = lines.join('\n');
  return text.length <= ALERT_LIMIT ? text : `${text.slice(0, ALERT_LIMIT - 1).trimEnd()}…`;
}

export interface OperatorAlertRequest {
  agent: typeof agents.$inferSelect;
  conversation: typeof conversations.$inferSelect;
  contact: typeof contacts.$inferSelect;
  /** Already passed through the turn's `safe`. */
  reason: string;
  urgent: boolean;
  summary: string;
  /** The turn's own `safe`, bound to its key, for the failure note. */
  sanitize: (text: string) => string;
}

/**
 * Tells the operator, or writes down why it could not. Never throws.
 *
 * The sender is the number the client wrote to, because that is the chat the operator will
 * open next. An Instagram thread has no such number, so it borrows the agent's oldest enabled
 * one; an agent with none has no way to reach anybody on WhatsApp and stays quiet.
 */
export async function notifyOperator(db: Db, deps: TurnDeps, input: OperatorAlertRequest): Promise<void> {
  const { agent, conversation, contact } = input;
  const target = agent.operatorNotifyPhone;
  if (!target) return;
  // The operator testing the agent from their own phone would otherwise be told about
  // themselves.
  if (contact.phone === target) return;

  try {
    const [number] = conversation.whatsappNumberId
      ? await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, conversation.whatsappNumberId))
      : await db.select().from(whatsappNumbers)
        .where(and(eq(whatsappNumbers.agentId, agent.id), eq(whatsappNumbers.enabled, true)))
        .orderBy(asc(whatsappNumbers.createdAt))
        .limit(1);
    // Switched off means the owner does not want anything leaving it, a staff alert included.
    if (!number || !number.enabled) return;

    const values = await db
      .select({ name: leadFields.name, value: leadValues.value })
      .from(leadValues)
      .innerJoin(leadFields, eq(leadFields.id, leadValues.fieldId))
      .where(eq(leadValues.conversationId, conversation.id))
      .orderBy(asc(leadFields.position));

    const text = formatOperatorAlert({
      urgent: input.urgent,
      contactName: contact.name,
      contactPhone: contact.phone,
      values,
      summary: input.summary,
      reason: input.reason,
      channel: conversation.whatsappNumberId ? 'whatsapp' : 'instagram',
    });

    // Built inside the try: a token the credentials key no longer opens throws here, and
    // that is one more reason the alert did not go, not a reason the turn failed.
    const transport = transportFor(number, {
      graph: deps.graph,
      linked: deps.linked,
      key: deps.key,
      onTokenRejected: () => markTokenRejected(db, number.id),
    });
    await transport.sendText(target, text);
  } catch (error) {
    // Meta refusing a number outside its 24-hour window is the ordinary case here, not an
    // exotic one — the setting's own helper text warns about it — so the reason is kept.
    const said = error instanceof Error ? error.message : String(error);
    const reason = said.replace(/[\s.]+$/, '') || 'неизвестная ошибка';
    try {
      await db.insert(notes).values({
        conversationId: conversation.id,
        authorId: null,
        body: input.sanitize(`Уведомление оператору не отправлено: ${reason}.`),
      });
    } catch {
      // Nowhere left to write it. The handoff note already tells the cabinet a person is needed.
    }
  }
}
