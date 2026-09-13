import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, aiReplies, contacts, conversations, crmAnalyses, kaspiPayments, leadFields, leadValues, messages, notes, orders, stages } from '../../db/schema.js';
import type { ModelClient } from '../ai/openrouter.js';
import { keyAad } from '../ai/turn.js';
import { decideAutomation, loadAutomationSnapshot, type AutomationPurpose } from '../automation/policy.js';
import { withAgentAutomationLock } from '../automation/execution.js';
import { queueLead, queuePurchase } from '../capi/enqueue.js';
import { recordStageMove } from '../funnel-history.js';
import { decryptSecret } from '../secret-box.js';
import { hasConfirmedKaspiPayment } from '../kaspi/service.js';
import { operatorLeftSale } from './payment.js';
import { crmPrompt, parseCrmAnalysis, resolveCrmStage, resolvePaymentEvidence, type CheckoutIntent } from './analysis.js';

export interface CrmDeps {
  model: ModelClient; key: Buffer;
  checkout?: (input: { agentId: string; conversationId: string; phone: string; intent: CheckoutIntent; summary: string }) => Promise<void>;
  reply?: (agentId: string, conversationId: string) => Promise<void>;
}
export interface AnalyzeInput { agentId: string; conversationId: string; live?: boolean }
export type AnalysisResult = 'ready' | 'skipped' | 'failed' | 'checkout';
const PAGE_SIZE = 100;
const RECENT_SIZE = 50;
const leaseDeadline = () => new Date(Date.now() + 120_000);
const messageColumns = { id: messages.id, author: messages.author, body: messages.body, kind: messages.kind,
  mediaMime: messages.mediaMime, sentAt: messages.sentAt, createdAt: messages.createdAt };

async function automationAllowed(db: Db, input: AnalyzeInput, purpose: AutomationPurpose) {
  const snapshot = await loadAutomationSnapshot(db,input);
  return snapshot !== null && decideAutomation(snapshot,purpose).allowed;
}

async function lockAutomationPolicy(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  input: AnalyzeInput,
) {
  const [locked] = await tx.select({stageId:conversations.stageId,stageSetAt:conversations.stageSetAt}).from(conversations)
    .innerJoin(agents,and(eq(agents.id,conversations.agentId),eq(agents.id,input.agentId)))
    .innerJoin(contacts,and(eq(contacts.id,conversations.contactId),eq(contacts.agentId,agents.id)))
    .where(eq(conversations.id,input.conversationId)).for('update');
  // The stage as it is now, under the lock: an operator may have moved the lead during the model call.
  return locked !== undefined && await automationAllowed(tx as unknown as Db,input,'crm') ? locked : null;
}

/** Page imported data by arrival order, but resolve evidence conflicts by message chronology. */
export async function analyzeConversation(db: Db, deps: CrmDeps, input: AnalyzeInput): Promise<AnalysisResult> {
  if (!await automationAllowed(db,input,'crm')) return 'skipped';
  const [row] = await db.select({ conversation: conversations, agent: agents, contact: contacts })
    .from(conversations).innerJoin(agents, eq(agents.id, conversations.agentId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.agentId, input.agentId)));
  if (!row || !row.agent.openrouterKey) return 'skipped';
  const { agent, conversation, contact } = row;
  await db.insert(crmAnalyses).values({ conversationId: conversation.id }).onConflictDoNothing();
  const token = randomUUID();
  const [claimed] = await db.update(crmAnalyses).set({ status: 'running', leaseToken: token,
    leaseUntil: leaseDeadline(), updatedAt: new Date(), error: null })
    .where(and(eq(crmAnalyses.conversationId, conversation.id),
      or(isNull(crmAnalyses.leaseUntil), lt(crmAnalyses.leaseUntil, new Date())))).returning();
  if (!claimed) return 'skipped';
  const ownLease = and(eq(crmAnalyses.conversationId, conversation.id), eq(crmAnalyses.leaseToken, token));
  // Model calls and a queued reply can outlast one lease window. Renewal never changes ownership.
  const heartbeat = setInterval(() => {
    void db.update(crmAnalyses).set({leaseUntil:leaseDeadline()}).where(ownLease).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try {
    // Capture the version before reading any model input, never after it.
    const [version] = await db.select(messageColumns).from(messages)
      .where(eq(messages.conversationId, conversation.id)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
    if (!version) {
      await db.update(crmAnalyses).set({status:'ready',leaseToken:null,leaseUntil:null}).where(ownLease);
      return 'skipped';
    }
    const liveId = claimed.pendingLiveMessageId !== claimed.handledLiveMessageId ? claimed.pendingLiveMessageId : null;
    if (claimed.analyzedMessageId === version.id && !liveId) {
      await db.update(crmAnalyses).set({status:'ready',leaseToken:null,leaseUntil:null}).where(ownLease);
      return 'skipped';
    }
    const snapshot = sql`(${messages.createdAt}, ${messages.id}) <= ((select created_at from messages where id = ${version.id}::uuid), ${version.id}::uuid)`;
    const [cursor] = claimed.analyzedMessageId ? await db.select(messageColumns).from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.id, claimed.analyzedMessageId))) : [];
    const page = await db.select(messageColumns).from(messages).where(and(eq(messages.conversationId, conversation.id), snapshot,
      cursor ? sql`(${messages.createdAt}, ${messages.id}) > ((select created_at from messages where id = ${cursor.id}::uuid), ${cursor.id}::uuid)` : undefined))
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(PAGE_SIZE);
    const recent = await db.select(messageColumns).from(messages).where(and(eq(messages.conversationId, conversation.id), snapshot,
      sql`${messages.author} <> 'system'`)).orderBy(desc(messages.sentAt), desc(messages.id)).limit(RECENT_SIZE);
    const history = [...new Map([...page, ...recent].filter((m) => m.author !== 'system').map((m) => [m.id, m])).values()]
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id.localeCompare(b.id));
    const last = history.at(-1);
    const scanned = page.at(-1) ?? cursor ?? version;
    const backlog = scanned.id !== version.id;
    const [funnel, fields, values, paid, undone] = await Promise.all([
      db.select().from(stages).where(eq(stages.agentId, agent.id)).orderBy(asc(stages.position)),
      db.select().from(leadFields).where(eq(leadFields.agentId, agent.id)).orderBy(asc(leadFields.position)),
      db.select({fieldId:leadValues.fieldId,value:leadValues.value,version:sql<string>`${leadValues.updatedAt}::text`}).from(leadValues).where(eq(leadValues.conversationId, conversation.id)),
      hasConfirmedKaspiPayment(db, agent.id, conversation.id),
      operatorLeftSale(db, conversation.id),
    ]);
    const inputHistory = history.map((m) => ({ ...m, body: m.body?.slice(0, Math.min(4000, Math.floor(60_000 / Math.max(1, history.length)))) ?? null }));
    if (!await automationAllowed(db,input,'crm')) {
      await db.update(crmAnalyses).set({status:'pending',leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(ownLease);
      return 'skipped';
    }
    const completion = await deps.model.complete({ key: decryptSecret(agent.openrouterKey!, deps.key, keyAad(agent.id)),
      model: agent.model, temperature: '0', maxTokens: 2200, messages: [
        { role: 'system', content: crmPrompt(funnel, fields) },
        { role: 'user', content: JSON.stringify({ previousAnalysis: { summary: claimed.summary,
          stageId: conversation.stageId, payment: resolvePaymentEvidence(claimed.profile.paymentEvidence,
            claimed.profile.paymentEvidenceReason, null, paid) }, profile: claimed.profile,
          fields: values.map((v) => ({fieldId:v.fieldId,value:v.value})),
          contact: { name: contact.name, phone: contact.phone }, history: inputHistory }) },
      ] });
    const analysis = parseCrmAnalysis(completion.text, inputHistory, fields);
    // A paid claim the model is unsure of is not stored, so it can neither move the lead nor stick.
    const payment = analysis.payment?.state === 'paid' && analysis.confidence < 65 ? null : analysis.payment;
    // An operator who took the lead out of the sale stage has overruled the chat; only Kaspi money moves it back.
    const target = resolveCrmStage(funnel, analysis.confidence >= 65 ? analysis.stageId : null,
      { paid: paid || (!undone && payment?.state === 'paid'), currentStageId: conversation.stageId });
    if (!await automationAllowed(db,input,'crm')) {
      await db.update(crmAnalyses).set({status:'pending',leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(ownLease);
      return 'skipped';
    }
    let moved = false;
    let chatOrderId: string | null = null;
    let applied = false;
    let policyDenied = false;
    await withAgentAutomationLock(db, input.agentId, async (tx) => {
      const [lease] = await tx.select().from(crmAnalyses).where(ownLease).for('update');
      if (!lease) return;
      const locked = await lockAutomationPolicy(tx,input);
      if (!locked) {
        policyDenied = true;
        await tx.update(crmAnalyses).set({status:'pending',leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(ownLease);
        return;
      }
      const [newest] = await tx.select({id:messages.id}).from(messages).where(eq(messages.conversationId, conversation.id))
        .orderBy(desc(messages.createdAt),desc(messages.id)).limit(1);
      if (newest?.id !== version.id) {
        await tx.update(crmAnalyses).set({status:'pending',leaseUntil:null,leaseToken:null}).where(ownLease);
        return;
      }
      const movedAt = new Date();
      if (target && target.id !== conversation.stageId) {
        const changed = await tx.update(conversations).set({stageId:target.id,stageSetBy:'ai',stageSetAt:movedAt})
          .where(and(eq(conversations.id,conversation.id),
            conversation.stageId === null ? isNull(conversations.stageId) : eq(conversations.stageId,conversation.stageId),
            conversation.stageSetAt === null ? isNull(conversations.stageSetAt) : eq(conversations.stageSetAt,conversation.stageSetAt)))
          .returning({id:conversations.id});
        moved = changed.length > 0;
        if (moved) await recordStageMove(tx,{agentId:agent.id,conversationId:conversation.id,
          from:funnel.find((s)=>s.id===conversation.stageId)??null,to:target,movedBy:'ai'});
      }
      const stageNow = moved ? target : target && target.id !== conversation.stageId ? null
        : funnel.find((s) => s.id === locked.stageId) ?? null;
      const evidence = {...lease.fieldEvidence};
      const profile = {...lease.profile};
      const accept = (key: string, value: string) => {
        const proof = analysis.evidence[key];
        const source = proof && history.find((m) => m.id === proof.messageId);
        if (!source) return null;
        const previous = evidence[key];
        const sentAt = source.sentAt.toISOString();
        if (previous && (sentAt < previous.sentAt || (sentAt === previous.sentAt && source.id < previous.messageId))) return null;
        return {messageId:source.id,sentAt,value};
      };
      for (const [key,value] of Object.entries(analysis.profile)) {
        const proof = accept(`profile:${key}`,value);
        if (proof) { profile[key] = value; evidence[`profile:${key}`] = proof; }
      }
      const paymentEvidence = resolvePaymentEvidence(profile.paymentEvidence, profile.paymentEvidenceReason, payment, paid);
      profile.paymentEvidence = paymentEvidence.state;
      if (paymentEvidence.reason) profile.paymentEvidenceReason = paymentEvidence.reason;
      else delete profile.paymentEvidenceReason;
      for (const [fieldId,value] of Object.entries(analysis.fields)) {
        const proof = accept(`field:${fieldId}`,value);
        if (!proof) continue;
        const original = values.find((v)=>v.fieldId===fieldId);
        const previous = evidence[`field:${fieldId}`];
        // A value differing from our last write belongs to an operator, even on later pages.
        if (original && (!previous || previous.value !== original.value)) continue;
        const changed = !original
          ? await tx.insert(leadValues).values({conversationId:conversation.id,fieldId,value}).onConflictDoNothing().returning()
          : await tx.update(leadValues).set({value,updatedAt:new Date()}).where(and(eq(leadValues.conversationId,conversation.id),eq(leadValues.fieldId,fieldId),sql`${leadValues.updatedAt} = ${original.version}::timestamptz`)).returning();
        if (changed.length) evidence[`field:${fieldId}`] = proof;
      }
      // One paid order per sale episode — since the lead last entered the sale stage, whoever moved
      // it there — so a customer buying again after being moved out and back gets a new order.
      // A Kaspi invoice in flight owns the money whenever it was issued.
      if (stageNow?.kind === 'success' && analysis.paidAmount && analysis.confidence >= 65 && !undone) {
        const episode = moved ? movedAt : locked.stageSetAt;
        const [paidOrder] = await tx.select({id:orders.id}).from(orders)
          .where(and(eq(orders.conversationId,conversation.id),eq(orders.status,'paid'),episode ? gte(orders.paidAt,episode) : undefined)).limit(1);
        const [invoice] = await tx.select({id:kaspiPayments.id}).from(kaspiPayments)
          .where(and(eq(kaspiPayments.conversationId,conversation.id),or(inArray(kaspiPayments.status,['creating','pending','unknown']),
            and(eq(kaspiPayments.status,'paid'),episode ? gte(kaspiPayments.createdAt,episode) : undefined)))).limit(1);
        if (!paidOrder && !invoice) {
          const [order] = await tx.insert(orders).values({agentId:agent.id,conversationId:conversation.id,amount:analysis.paidAmount,
            currency:agent.currency,status:'paid',comment:'Оплата по переписке',
            paidAt:moved ? movedAt : locked.stageSetAt ?? movedAt}).returning({id:orders.id});
          chatOrderId = order!.id;
        }
      }
      if (profile.name && !contact.name) await tx.update(contacts).set({name:profile.name}).where(and(eq(contacts.id,contact.id),isNull(contacts.name)));
      await tx.update(crmAnalyses).set({sourceVersion:scanned.createdAt,analyzedMessageId:scanned.id,
        summary:analysis.summary,profile,fieldEvidence:evidence,confidence:analysis.confidence,
        analyzedAt:new Date(),updatedAt:new Date(),leaseUntil:leaseDeadline(),error:null}).where(ownLease);
      await tx.insert(aiReplies).values({agentId:agent.id,conversationId:conversation.id,model:agent.model,
        configVersion:agent.configVersion,
        promptTokens:completion.promptTokens,completionTokens:completion.completionTokens,cost:completion.cost,
        outcome:'applied',detail:'CRM analysis completed',usedItemIds:[]});
      applied = true;
    });
    if (policyDenied) return 'skipped';
    if (!applied) return 'skipped';
    // Reported like a Kaspi sale: an ad report, not a customer effect, so no live trigger is needed.
    if (chatOrderId) await queuePurchase(db,{agentId:agent.id,orderId:chatOrderId});
    let checkedOut = false;
    // Only a persisted live delivery authorizes customer side effects, never a backfill flag.
    if (liveId && last?.id === liveId && last.author === 'client' && Date.now()-last.sentAt.getTime() >= 0
      && Date.now()-last.sentAt.getTime() < 5*60_000) {
      const [current] = await db.select({agentEnabled:agents.aiEnabled,conversationEnabled:conversations.aiEnabled,
        crmAnalysisMode:agents.crmAnalysisMode,stageKind:stages.kind,stageSetAt:conversations.stageSetAt})
        .from(conversations).innerJoin(agents,eq(agents.id,conversations.agentId)).leftJoin(stages,eq(stages.id,conversations.stageId))
        .where(eq(conversations.id,conversation.id));
      if (agent.crmAnalysisMode === 'follow_ai' && current?.crmAnalysisMode === 'follow_ai' && moved && await automationAllowed(db,input,'crm')) {
        await queueLead(db,{agentId:agent.id,conversationId:conversation.id,
          canQueue:async (effectDb) => {
            const snapshot=await loadAutomationSnapshot(effectDb,input);
            return snapshot?.crmAnalysisMode === 'follow_ai' && decideAutomation(snapshot,'crm').allowed;
          }});
      }
      const [latest] = await db.select({id:messages.id}).from(messages).where(eq(messages.conversationId,conversation.id))
        .orderBy(desc(messages.sentAt),desc(messages.id)).limit(1);
      if (agent.crmAnalysisMode === 'follow_ai' && current?.crmAnalysisMode === 'follow_ai' && current.agentEnabled && current.conversationEnabled && latest?.id === liveId) {
        const wantsCheckout = Boolean(deps.checkout && analysis.checkout?.messageId === liveId && analysis.confidence >= 85
          // Only the current sale episode blocks an invoice: a repeat customer moved back into work can buy again.
          && !(current.stageKind === 'success' && (await db.select({id:orders.id}).from(orders).where(and(eq(orders.conversationId,conversation.id),
            eq(orders.status,'paid'),current.stageSetAt ? gte(orders.paidAt,current.stageSetAt) : undefined)).limit(1)).length)
          && await automationAllowed(db,input,'checkout'));
        if (wantsCheckout && contact.phone) {
          await deps.checkout!({agentId:agent.id,conversationId:conversation.id,phone:contact.phone,
            intent:analysis.checkout!,summary:analysis.summary});
          checkedOut = true;
        } else if (deps.reply && await automationAllowed(db,input,'reply')) {
          // No phone means no Kaspi invoice (an Instagram customer); the owner is told, and the
          // customer still gets the ordinary reply rather than silence.
          if (wantsCheckout) await db.insert(notes).values({ conversationId: conversation.id,
            body: 'Счёт Kaspi не создан: у клиента нет номера телефона. Добавьте номер в карточку клиента и повторите действие.' });
          await deps.reply(agent.id,conversation.id);
        }
      }
    }
    await db.update(crmAnalyses).set({
      status:sql`case when ${crmAnalyses.pendingLiveMessageId} is not null and ${crmAnalyses.pendingLiveMessageId} is distinct from ${liveId}::uuid then 'pending' else ${backlog ? 'pending' : 'ready'} end`,
      ...(liveId ? {handledLiveMessageId:liveId,pendingLiveMessageId:sql`case when ${crmAnalyses.pendingLiveMessageId} = ${liveId}::uuid then null else ${crmAnalyses.pendingLiveMessageId} end`} : {}),
      leaseToken:null,leaseUntil:null,updatedAt:new Date(),error:null,
    }).where(ownLease);
    return checkedOut ? 'checkout' : 'ready';
  } catch (error) {
    // Log validation metadata only: model output and customer text never belong in logs.
    const detail = error as { name?: string; issues?: { code: string; path: PropertyKey[] }[]; cause?: { code?: string } };
    console.warn(JSON.stringify({event:'crm_analysis_failed',conversationId:conversation.id,
      errorType:detail?.name??'unknown',databaseCode:detail?.cause?.code,
      issues:detail?.issues?.slice(0,5).map((issue)=>({code:issue.code,path:issue.path}))}));
    await db.update(crmAnalyses).set({status:'failed',error:'Не удалось завершить ИИ-разбор. Повторим автоматически.',
      leaseToken:null,leaseUntil:null,updatedAt:new Date()}).where(ownLease);
    return 'failed';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Discover both historical pages and deferred live work without turning imports into replies. */
export async function drainCrmAnalyses(db: Db, deps: CrmDeps): Promise<void> {
  const retryBefore = new Date(Date.now()-5*60_000);
  const pending = await db.select({conversationId:conversations.id,agentId:conversations.agentId}).from(conversations)
    .innerJoin(agents,eq(agents.id,conversations.agentId))
    .innerJoin(contacts,and(eq(contacts.id,conversations.contactId),eq(contacts.agentId,agents.id)))
    .leftJoin(crmAnalyses,eq(crmAnalyses.conversationId,conversations.id))
    .where(and(isNotNull(agents.openrouterKey),
      or(eq(agents.crmAnalysisMode,'independent'),and(eq(agents.crmAnalysisMode,'follow_ai'),eq(conversations.aiEnabled,true),
        or(eq(agents.responseMode,'live'),and(eq(agents.responseMode,'test'),eq(agents.testContactId,contacts.id))))),
      sql`exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.author <> 'system')`,
      or(sql`${crmAnalyses.analyzedMessageId} is distinct from (select m.id from messages m where m.conversation_id = ${conversations.id} order by m.created_at desc, m.id desc limit 1)`,
        sql`${crmAnalyses.pendingLiveMessageId} is not null and ${crmAnalyses.pendingLiveMessageId} is distinct from ${crmAnalyses.handledLiveMessageId}`),
      or(isNull(crmAnalyses.leaseUntil),lt(crmAnalyses.leaseUntil,new Date())),
      or(sql`${crmAnalyses.status} is distinct from 'failed'`,lt(crmAnalyses.updatedAt,retryBefore))))
    .orderBy(sql`${crmAnalyses.pendingLiveMessageId} is not null desc`,asc(crmAnalyses.updatedAt),desc(conversations.lastMessageAt)).limit(8);
  for(let i=0;i<pending.length;i+=2) await Promise.all(pending.slice(i,i+2).map((input)=>analyzeConversation(db,deps,input)));
}
