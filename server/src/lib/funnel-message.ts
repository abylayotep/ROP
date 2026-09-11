import { and, eq } from 'drizzle-orm';
import { windowOpen } from '../api/conversations.js';
import type { Db } from '../db/client.js';
import { contacts, conversations, messages, notes, stages, whatsappNumbers } from '../db/schema.js';
import { decryptSecret } from './secret-box.js';
import { asCloudNumber } from './whatsapp/cloud-number.js';
import { GraphError, withoutSecret, type GraphClient } from './whatsapp/graph.js';

export interface StageMessageDeps {
  graph: GraphClient;
  key: Buffer;
}

/**
 * Fills a stage's template.
 *
 * A lead with no profile name gets nothing where the name would be, not a placeholder:
 * the customer reads this text, and "Здравствуйте, клиент!" is worse than the comma.
 * An unknown placeholder is left as written — silently deleting it would hide the typo
 * from whoever wrote the template.
 */
export function renderTemplate(template: string, contactName: string | null): string {
  return template.split('{{name}}').join(contactName ?? '');
}

/**
 * Sends the template of the stage a lead has just entered, or records why it could not.
 *
 * Never throws. The stage move is what the operator asked for and it has already
 * happened; the message is the extra, and an extra that fails must not undo the ask.
 * Every refusal lands as a note on the lead, where the person who moved it will see it.
 */
export async function sendStageMessage(
  db: Db,
  deps: StageMessageDeps,
  input: { agentId: string; conversationId: string; stageId: string },
): Promise<void> {
  const note = (body: string) =>
    db.insert(notes).values({ conversationId: input.conversationId, authorId: null, body });

  try {
    // Scoped by agent even though the route has already proved the stage belongs to this
    // one: a helper that only refuses what its caller happened to check is a helper the
    // next caller will misuse.
    const [stage] = await db
      .select()
      .from(stages)
      .where(and(eq(stages.id, input.stageId), eq(stages.agentId, input.agentId)));
    const text = stage?.autoMessage?.trim();
    if (!text) return;

    const [row] = await db
      .select({ conversation: conversations, contact: contacts, number: whatsappNumbers })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
      .where(
        and(eq(conversations.id, input.conversationId), eq(conversations.agentId, input.agentId)),
      );
    if (!row) return;

    if (!row.number.enabled) {
      await note(`Автосообщение стадии «${stage!.name}» не отправлено: номер отключён.`);
      return;
    }
    if (!windowOpen(row.conversation.lastInboundAt)) {
      await note(
        `Автосообщение стадии «${stage!.name}» не отправлено: окно ответа закрыто, ` +
          'клиент не писал больше суток.',
      );
      return;
    }

    const body = renderTemplate(text, row.contact.name);

    // Decrypted on its own, ahead of the send, so its failure gets its own sentence. A key
    // that no longer matches the stored token throws an English developer message, and this
    // note is read by an operator who needs to be told what to do about it instead.
    let token: string;
    try {
      const cloud = asCloudNumber(row.number);
      token = decryptSecret(cloud.accessToken, deps.key, cloud.phoneNumberId);
    } catch {
      await note(
        `Автосообщение стадии «${stage!.name}» не отправлено: не удалось прочитать токен ` +
          'номера. Подключите номер заново в интеграциях.',
      );
      return;
    }

    // Set the instant Meta accepts the message, before any write of our own. It is the only
    // thing that can tell a failed send apart from a send we failed to record.
    let sent = false;
    try {
      const { messageId } = await deps.graph.sendText(
        asCloudNumber(row.number).phoneNumberId,
        token,
        row.contact.phone,
        body,
      );
      sent = true;

      const sentAt = new Date();
      await db.insert(messages).values({
        conversationId: input.conversationId,
        waMessageId: messageId,
        direction: 'out',
        // Not 'operator': nobody typed this. Stage 5's replies are 'ai', and the thread
        // has to be able to say which of the three sent a line.
        author: 'system',
        kind: 'text',
        body,
        status: 'sent',
        sentAt,
      });
      await db
        .update(conversations)
        .set({ lastMessageAt: sentAt })
        .where(eq(conversations.id, input.conversationId));
    } catch (error) {
      const reason =
        error instanceof GraphError || error instanceof Error ? error.message : String(error);
      // Meta echoes a rejected token back inside its own error text. Redacted before it
      // reaches a column anyone can read.
      //
      // `sent` is the difference between "the customer never got it" and "the customer got
      // it and we failed to record that". An operator who reads the first re-sends; one who
      // reads the second must not.
      //
      // A timeout is the third outcome and the only honest word for it is "unknown": Meta
      // may have accepted the message and simply not said so in time, and there is no
      // idempotency key here to settle it. Told it failed, an operator sends the customer
      // a second copy of the same greeting.
      const timedOut = error instanceof GraphError && error.status === 504;
      await note(
        sent
          ? `Автосообщение стадии «${stage!.name}» отправлено, но не сохранено в переписке: ${withoutSecret(reason, token)}`
          : timedOut
            ? `Автосообщение стадии «${stage!.name}»: Meta не ответила вовремя, сообщение могло уйти. ` +
              'Посмотрите переписку, прежде чем писать клиенту ещё раз.'
            : `Автосообщение стадии «${stage!.name}» не отправлено: ${withoutSecret(reason, token)}`,
      );
    }
  } catch {
    // Even the note failed. There is nothing left to tell anyone with, and raising here
    // would turn a successful stage move into a 500.
  }
}
