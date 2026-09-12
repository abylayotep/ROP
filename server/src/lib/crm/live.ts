import { join } from 'node:path';
import QRCode from 'qrcode';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, contacts, conversations, crmAnalyses, kaspiPayments, messages, notes, whatsappNumbers } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { runTurn, type TurnDeps } from '../ai/turn.js';
import { ApiError } from '../errors.js';
import { createKaspiCheckout } from '../kaspi/service.js';
import { storeInboundMedia } from '../whatsapp/media.js';
import { transportFor } from '../whatsapp/transport.js';
import { markTokenRejected } from '../whatsapp/token-expiry.js';
import { windowOpen } from '../../api/conversations.js';
import { analyzeConversation, type CrmDeps } from './worker.js';

/** Called only by the live inbound path, never by history import or the background backfill. */
export function createCrmDeps(db: Db, env: Env, deps: TurnDeps): CrmDeps {
  const checkout: NonNullable<CrmDeps['checkout']> = async (input) => {
    const [row] = await db.select({ conversation: conversations, contact: contacts, number: whatsappNumbers, agent: agents })
      .from(conversations).innerJoin(contacts,eq(contacts.id,conversations.contactId))
      .innerJoin(whatsappNumbers,eq(whatsappNumbers.id,conversations.whatsappNumberId))
      .innerJoin(agents,eq(agents.id,conversations.agentId))
      .where(and(eq(conversations.id,input.conversationId),eq(conversations.agentId,input.agentId)));
    if (!row || !row.agent.aiEnabled || !row.conversation.aiEnabled || !row.number.enabled) return;
    const [latest] = await db.select({id:messages.id}).from(messages).where(eq(messages.conversationId,input.conversationId))
      .orderBy(desc(messages.sentAt),desc(messages.id)).limit(1);
    if (latest?.id !== input.intent.messageId) return;
    const transport = transportFor(row.number,{...deps,onTokenRejected:()=>markTokenRejected(db,row.number.id)});
    if (transport.requiresOpenWindow && !windowOpen(row.conversation.lastInboundAt)) return;
    if (row.number.connectionKind === 'linked' && !deps.linked.isOpen(row.number.id)) return;
    const payment = await createKaspiCheckout(db,env,{agentId:input.agentId,conversationId:input.conversationId,
      amount:input.intent.amount,phone:row.contact.phone,method:input.intent.method,requestKey:`crm:${input.intent.messageId}`,
      comment:input.summary});
    if (payment.status !== 'pending') throw new ApiError(409,'Счёт Kaspi требует проверки в карточке клиента');
    let media: {path:string;mime:string}|null = null;
    const body = input.intent.method === 'invoice'
      ? `Счёт на ${payment.amount} ₸ отправлен на номер ${payment.phone}. Откройте Kaspi и подтвердите оплату.`
      : `QR для оплаты ${payment.amount} ₸`;
    if (input.intent.method === 'qr') {
      if (!payment.qrToken) throw new ApiError(502,'Kaspi не вернул QR для оплаты');
      media = await storeInboundMedia({mediaDir:env.MEDIA_DIR},{agentId:input.agentId,waMessageId:`kaspi-${payment.id}`,
        mime:'image/png',bytes:await QRCode.toBuffer(payment.qrToken,{width:512,margin:3})});
    }
    // Commit before the external effect. A crash or lost acknowledgement leaves unknown,
    // which is intentionally never eligible for an automatic retry.
    const [claimed] = await db.update(kaspiPayments)
      .set({ notificationStatus: 'unknown', notificationClaimedAt: new Date() })
      .where(and(eq(kaspiPayments.id, payment.id), eq(kaspiPayments.agentId, input.agentId),
        eq(kaspiPayments.conversationId, input.conversationId), eq(kaspiPayments.notificationStatus, 'pending')))
      .returning({ id: kaspiPayments.id });
    if (!claimed) return;
    let accepted = false;
    try {
      const sent = media
        ? await transport.sendMedia(row.contact.phone,{path:join(env.MEDIA_DIR,media.path),mime:media.mime,caption:body})
        : await transport.sendText(row.contact.phone,body);
      accepted = true;
      await db.transaction(async (tx) => {
      await tx.insert(messages).values({conversationId:input.conversationId,waMessageId:sent.messageId,direction:'out',author:'ai',
        kind:media?'image':'text',body,mediaPath:media?.path??null,mediaMime:media?.mime??null,status:'sent',sentAt:new Date()}).onConflictDoNothing();
      await tx.update(conversations).set({lastMessageAt:new Date()}).where(eq(conversations.id,input.conversationId));
      await tx.update(kaspiPayments).set({ notificationStatus: 'sent', notificationMessageId: sent.messageId }).where(eq(kaspiPayments.id, payment.id));
      });
    } catch {
      await db.insert(notes).values({conversationId:input.conversationId,body:accepted
        ? 'Счёт создан; сообщение об оплате могло уйти, но не сохранилось. Проверьте переписку перед повторной отправкой.'
        : 'Счёт Kaspi создан; результат доставки сообщения неизвестен. Автоматический повтор заблокирован. Проверьте переписку и кассу.'});
      throw new ApiError(502,'Счёт создан. Проверьте доставку сообщения в переписке');
    }
  };
  return { model:deps.model,key:deps.key,checkout,
    reply: async (agentId,conversationId) => { await runTurn(db,{...deps,crm:async()=>true},{agentId,conversationId}); },
  };
}

export function createLiveCrmHandler(db: Db, env: Env, deps: TurnDeps) {
  const crmDeps = createCrmDeps(db,env,deps);
  return async (agentId:string,conversationId:string):Promise<boolean> => {
    const [agent] = await db.select({key:agents.openrouterKey}).from(agents).where(eq(agents.id,agentId));
    if (!agent?.key) return false;
    const [latest] = await db.select().from(messages).where(eq(messages.conversationId,conversationId))
      .orderBy(desc(messages.sentAt),desc(messages.id)).limit(1);
    if (!latest || latest.author !== 'client' || Date.now()-latest.sentAt.getTime()>5*60_000) return false;
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:latest.id})
      .onConflictDoUpdate({target:crmAnalyses.conversationId,set:{pendingLiveMessageId:latest.id},
        setWhere:sql`${crmAnalyses.handledLiveMessageId} is distinct from ${latest.id}::uuid`});
    await analyzeConversation(db,crmDeps,{agentId,conversationId,live:true});
    // A busy lease retains the trigger; the background worker will complete its reply.
    return true;
  };
}
