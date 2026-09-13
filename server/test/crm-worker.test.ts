import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDb } from './helpers/db.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { agents, aiReplies, capiEvents, contacts, conversations, crmAnalyses, kaspiPayments, leadFields, leadValues, messages, notes, orders, stages, whatsappNumbers } from '../src/db/schema.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { analyzeConversation, drainCrmAnalyses } from '../src/lib/crm/worker.js';
import { hasVisiblePayment, operatorLeftSale } from '../src/lib/crm/payment.js';
import { recordStageMove } from '../src/lib/funnel-history.js';
import * as automationPolicy from '../src/lib/automation/policy.js';
import { ApiError } from '../src/lib/errors.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string; let conversationId: string; let messageId: string; let targetId: string;
const key = Buffer.alloc(32, 7);
const model = { complete: vi.fn() };
beforeEach(async () => {
  db = await withDb(); model.complete.mockReset();
  const { accountId } = await createAccountWithOwner(db, { company: 'CRM test', email: 'crm@example.com', name: 'Owner', initials: 'CR', password: 'test-password-crm' });
  const [agent] = await db.insert(agents).values({ accountId, name: 'CRM', responseMode: 'live' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ aiEnabled: false, openrouterKey: encryptSecret('model-key', key, agentId) }).where(eq(agents.id, agentId));
  await seedFunnel(db, agentId);
  const [target] = await db.select().from(stages).where(eq(stages.agentId, agentId));
  targetId = target!.id;
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: 'crm', wabaId: 'crm', displayPhone: '77010000000', accessToken: 'x' }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77011234567' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id, aiEnabled: true }).returning();
  conversationId = conversation!.id;
  const [message] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Меня зовут Айгуль. Алматы.', sentAt: new Date('2026-01-01') }).returning();
  messageId = message!.id;
  model.complete.mockResolvedValue({ text: JSON.stringify({ stageId: targetId, summary: 'Новое обращение из Алматы', confidence: 95,
    profile: { name: {value:'Айгуль',messageId,quote:'Айгуль'}, city: {value:'Алматы',messageId,quote:'Алматы'} }, fields: {}, checkout: null }),
    promptTokens: 100, completionTokens: 50, cost: '0.001' });
});

describe('independent CRM analysis', () => {
  it('analyzes disabled-reply conversations while keeping customer effects off', async () => {
    await db.update(agents).set({responseMode:'off',aiEnabled:false,crmAnalysisMode:'independent'}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:false}).where(eq(conversations.id,conversationId));
    const checkout=vi.fn(); const reply=vi.fn();
    await drainCrmAnalyses(db,{model,key,checkout,reply});
    const [conversation]=await db.select().from(conversations).where(eq(conversations.id,conversationId));
    const [analysis]=await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId,conversationId));
    expect(conversation?.stageId).toBe(targetId);
    expect(analysis?.status).toBe('ready');
    expect(checkout).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(await db.select().from(capiEvents)).toHaveLength(0);
  });
  it('does not use stale live markers for effects in independent mode', async () => {
    await db.update(agents).set({responseMode:'live',aiEnabled:true,crmAnalysisMode:'independent'}).where(eq(agents.id,agentId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    const checkout=vi.fn(); const reply=vi.fn();
    await analyzeConversation(db,{model,key,checkout,reply},{agentId,conversationId,live:true});
    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(checkout).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(await db.select().from(capiEvents)).toHaveLength(0);
  });
  it('keeps an analysis started independently free of effects if mode changes during the model call', async () => {
    await db.update(agents).set({responseMode:'live',aiEnabled:true,crmAnalysisMode:'independent'}).where(eq(agents.id,agentId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    const original=model.complete.getMockImplementation()!;
    model.complete.mockImplementationOnce(async (...args:unknown[])=>{
      await db.update(agents).set({crmAnalysisMode:'follow_ai'}).where(eq(agents.id,agentId));
      return original(...args);
    });
    const checkout=vi.fn(); const reply=vi.fn();
    await analyzeConversation(db,{model,key,checkout,reply},{agentId,conversationId,live:true});
    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(checkout).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(await db.select().from(capiEvents)).toHaveLength(0);
  });
  it('classifies old conversations without customer side effects', async () => {
    const checkout = vi.fn();
    await analyzeConversation(db, { model, key, checkout }, { agentId, conversationId });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    const [analysis] = await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
    expect(conversation?.stageId).toBe(targetId);
    expect(conversation?.aiEnabled).toBe(true);
    expect(analysis?.profile).toMatchObject({ name:'Айгуль',city:'Алматы',paymentEvidence:'unknown' });
    expect(analysis?.profile.paymentEvidenceReason).toBeUndefined();
    expect(analysis?.status).toBe('ready');
    expect(checkout).not.toHaveBeenCalled();
    expect(await db.select().from(messages)).toHaveLength(1);
  });
  it('skips queued CRM analysis before calling the model when automation is denied', async () => {
    await db.update(agents).set({responseMode:'off'}).where(eq(agents.id,agentId));

    expect(await analyzeConversation(db,{model,key},{agentId,conversationId})).toBe('skipped');

    expect(model.complete).not.toHaveBeenCalled();
    expect(await db.select().from(crmAnalyses)).toHaveLength(0);
    expect((await db.select().from(conversations))[0]?.stageId).toBeNull();
    expect((await db.select().from(contacts))[0]?.name).toBeNull();
    expect(await db.select().from(leadValues)).toHaveLength(0);
  });
  // An Instagram customer has no phone, so no Kaspi invoice can be issued; the owner is told,
  // and the customer still gets the normal reply instead of silence.
  it('notes a phoneless checkout intent and still replies to the customer', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(contacts).set({phone:null});
    const [offer] = await db.insert(messages).values({conversationId,direction:'out',author:'operator',kind:'text',
      body:'Итого 5000 ₸',sentAt:new Date(Date.now()-60_000)}).returning();
    await db.update(messages).set({body:'Отправьте счёт, пожалуйста',sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    model.complete.mockResolvedValueOnce({text:JSON.stringify({stageId:targetId,summary:'Хочет оплатить',confidence:95,
      profile:{},fields:{},
      checkout:{method:'invoice',messageId,quote:'Отправьте счёт',amount:'5000',amountMessageId:offer!.id}}),
      promptTokens:1,completionTokens:1,cost:'0'});
    const checkout = vi.fn();
    const reply = vi.fn();

    await analyzeConversation(db,{model,key,checkout,reply},{agentId,conversationId,live:true});

    expect(checkout).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(agentId,conversationId);
    expect((await db.select().from(notes)).map((row)=>row.body).join(' ')).toContain('у клиента нет номера телефона');
  });
  it('applies no CRM or checkout effects when response mode changes during analysis', async () => {
    const [field] = await db.insert(leadFields).values({agentId,name:'City',kind:'text',position:99}).returning();
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    model.complete.mockImplementationOnce(async () => {
      await db.update(agents).set({responseMode:'off'}).where(eq(agents.id,agentId));
      return {text:JSON.stringify({stageId:targetId,summary:'Denied',confidence:95,
        profile:{name:{value:'Айгуль',messageId,quote:'Айгуль'}},
        fields:{[field!.id]:{value:'Алматы',messageId,quote:'Алматы'}},
        checkout:{method:'invoice',messageId,quote:'Отправьте счёт',amount:'5000',amountMessageId:messageId}}),
        promptTokens:1,completionTokens:1,cost:'0'};
    });
    const checkout = vi.fn();
    const reply = vi.fn();

    expect(await analyzeConversation(db,{model,key,checkout,reply},{agentId,conversationId,live:true})).toBe('skipped');

    expect(model.complete).toHaveBeenCalledTimes(1);
    expect((await db.select().from(conversations))[0]?.stageId).toBeNull();
    expect((await db.select().from(contacts))[0]?.name).toBeNull();
    expect(await db.select().from(leadValues)).toHaveLength(0);
    expect(checkout).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
  it('rechecks policy inside the CRM transaction before committing model effects', async () => {
    const [field] = await db.insert(leadFields).values({agentId,name:'City',kind:'text',position:99}).returning();
    model.complete.mockResolvedValueOnce({text:JSON.stringify({stageId:targetId,summary:'Denied',confidence:95,
      profile:{name:{value:'Айгуль',messageId,quote:'Айгуль'}},
      fields:{[field!.id]:{value:'Алматы',messageId,quote:'Алматы'}},checkout:null}),
      promptTokens:1,completionTokens:1,cost:'0'});
    const originalLoad = automationPolicy.loadAutomationSnapshot;
    let changed = false;
    const load = vi.spyOn(automationPolicy, 'loadAutomationSnapshot').mockImplementation(async (...args) => {
      const snapshot = await originalLoad(...args);
      if (!changed && model.complete.mock.calls.length === 1) {
        changed = true;
        await db.update(agents).set({responseMode:'off'}).where(eq(agents.id,agentId));
      }
      return snapshot;
    });

    let result;
    try {
      result = await analyzeConversation(db,{model,key},{agentId,conversationId});
    } finally {
      load.mockRestore();
    }

    expect(result).toBe('skipped');
    expect((await db.select().from(conversations))[0]?.stageId).toBeNull();
    expect((await db.select().from(contacts))[0]?.name).toBeNull();
    expect(await db.select().from(leadValues)).toHaveLength(0);
    expect(await db.select().from(aiReplies)).toHaveLength(0);
  });
  it('rechecks policy at the queueLead insert site', async () => {
    const [qualified] = (await db.select().from(stages).where(eq(stages.agentId,agentId)))
      .filter((stage) => stage.kind === 'qualified');
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({ctwaClid:'click-1'}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    model.complete.mockResolvedValueOnce({text:JSON.stringify({stageId:qualified!.id,summary:'Qualified',confidence:95,
      profile:{},fields:{},checkout:null}),promptTokens:1,completionTokens:1,cost:'0'});
    const originalLoad = automationPolicy.loadAutomationSnapshot;
    let changed = false;
    const load = vi.spyOn(automationPolicy, 'loadAutomationSnapshot').mockImplementation(async (...args) => {
      const snapshot = await originalLoad(...args);
      const [current] = await db.select({stageId:conversations.stageId}).from(conversations)
        .where(eq(conversations.id,conversationId));
      if (!changed && snapshot?.responseMode === 'live' && current?.stageId === qualified!.id) {
        changed = true;
        await db.update(agents).set({responseMode:'off'}).where(eq(agents.id,agentId));
      }
      return snapshot;
    });

    try {
      await analyzeConversation(db,{model,key},{agentId,conversationId,live:true});
    } finally {
      load.mockRestore();
    }

    expect(changed).toBe(true);
    expect(await db.select().from(capiEvents)).toHaveLength(0);
  });
  it('does not let denied CRM jobs starve an allowed conversation and processes them later', async () => {
    const [base] = await db.select().from(agents).where(eq(agents.id,agentId));
    const deniedAgentId = randomUUID();
    await db.insert(agents).values({id:deniedAgentId,accountId:base!.accountId,name:'Denied',responseMode:'off',
      openrouterKey:encryptSecret('denied-key',key,deniedAgentId)});
    const [number] = await db.insert(whatsappNumbers).values({agentId:deniedAgentId,phoneNumberId:'denied-crm',
      wabaId:'denied-crm',displayPhone:'77010000001',accessToken:'x'}).returning();
    for (let index=0;index<8;index++) {
      const [contact] = await db.insert(contacts).values({agentId:deniedAgentId,phone:`7702000000${index}`}).returning();
      const [conversation] = await db.insert(conversations).values({agentId:deniedAgentId,contactId:contact!.id,
        whatsappNumberId:number!.id,aiEnabled:true}).returning();
      const [message] = await db.insert(messages).values({conversationId:conversation!.id,direction:'in',author:'client',
        kind:'text',body:`Denied ${index}`,sentAt:new Date()}).returning();
      await db.insert(crmAnalyses).values({conversationId:conversation!.id,pendingLiveMessageId:message!.id});
    }

    await drainCrmAnalyses(db,{model,key});

    expect(model.complete).toHaveBeenCalledTimes(1);
    await db.update(agents).set({responseMode:'live'}).where(eq(agents.id,deniedAgentId));
    await drainCrmAnalyses(db,{model,key});
    expect(model.complete).toHaveBeenCalledTimes(9);
  });
  it('does not reanalyze unchanged conversations', async () => {
    await drainCrmAnalyses(db, {model,key});
    await drainCrmAnalyses(db, {model,key});
    expect(model.complete).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite an operator stage changed during model work', async () => {
    const [other] = (await db.select().from(stages).where(eq(stages.agentId, agentId))).filter((s) => s.id !== targetId);
    model.complete.mockImplementationOnce(async () => {
      await db.update(conversations).set({ stageId: other!.id, stageSetBy: 'operator', stageSetAt: new Date() }).where(eq(conversations.id, conversationId));
      return {text: JSON.stringify({stageId:targetId,summary:'New',confidence:95,profile:{},fields:{},checkout:null}),promptTokens:1,completionTokens:1,cost:'0'};
    });
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id,conversationId));
    expect(conversation?.stageId).toBe(other!.id);
    expect(conversation?.stageSetBy).toBe('operator');
  });
  it('keeps a visible retryable failure instead of silently assigning guessed stages', async () => {
    model.complete.mockRejectedValueOnce(new Error('provider unavailable'));
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    const [analysis] = await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId,conversationId));
    expect(analysis?.status).toBe('failed');
    expect(analysis?.error).toBeTruthy();
  });
  it('scans every historical message in bounded pages instead of marking an unseen backlog complete', async () => {
    const createdAt = Date.now();
    const extra = await db.insert(messages).values(Array.from({length:205}, (_, index) => ({
      conversationId, direction:'in', author:'client', kind:'text', body:`History ${index}`,
      sentAt:new Date(Date.UTC(2026,0,2)+index*1000), createdAt:new Date(createdAt+index+1),
    }))).returning({id:messages.id});
    const seen = new Set<string>();
    model.complete.mockImplementation(async (request) => {
      const prompt = JSON.parse(request.messages[1].content);
      expect(prompt.history.length).toBeLessThanOrEqual(150);
      for (const entry of prompt.history) seen.add(entry.id);
      return {text:JSON.stringify({stageId:null,summary:'Scanned',confidence:90,profile:{},fields:{},checkout:null}),
        promptTokens:1,completionTokens:1,cost:'0'};
    });
    await drainCrmAnalyses(db,{model,key});
    expect((await db.select().from(crmAnalyses))[0]?.status).toBe('pending');
    for (let page=0;page<4;page++) await drainCrmAnalyses(db,{model,key});
    expect(seen.has(messageId)).toBe(true);
    expect(extra.every((entry)=>seen.has(entry.id))).toBe(true);
    expect((await db.select().from(crmAnalyses))[0]?.status).toBe('ready');
    expect(model.complete).toHaveBeenCalledTimes(3);
  });

  it('does not advance its scan cursor when a new message arrives during model work', async () => {
    model.complete.mockImplementationOnce(async () => {
      await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',body:'New arrival',sentAt:new Date()});
      return {text:JSON.stringify({stageId:null,summary:'Stale',confidence:90,profile:{},fields:{},checkout:null}),
        promptTokens:1,completionTokens:1,cost:'0'};
    });
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    const [state] = await db.select().from(crmAnalyses);
    expect(state?.analyzedMessageId).toBeNull();
    expect(state?.status).toBe('pending');
  });

  it('does not let newly imported old evidence replace a newer known profile value', async () => {
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    const [old] = await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',
      body:'Раньше жил в Астане',sentAt:new Date('2025-01-01')}).returning();
    model.complete.mockResolvedValueOnce({text:JSON.stringify({stageId:null,summary:'Older context',confidence:90,
      profile:{city:{value:'Астане',messageId:old!.id,quote:'Астане'}},fields:{},checkout:null}),
      promptTokens:1,completionTokens:1,cost:'0'});
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    expect((await db.select().from(crmAnalyses))[0]?.profile.city).toBe('Алматы');
  });

  it('keeps a deferred live reply under the lease and handles its trigger only once', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:true}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    let replies = 0;
    const reply = async () => {
      replies++;
      const [state] = await db.select().from(crmAnalyses);
      expect(state?.leaseToken).toBeTruthy();
      expect(state?.pendingLiveMessageId).toBe(messageId);
      expect(await analyzeConversation(db,{model,key,reply},{agentId,conversationId,live:true})).toBe('skipped');
    };
    await drainCrmAnalyses(db,{model,key,reply});
    await drainCrmAnalyses(db,{model,key,reply});
    const [state] = await db.select().from(crmAnalyses);
    expect(replies).toBe(1);
    expect(state?.pendingLiveMessageId).toBeNull();
    expect(state?.handledLiveMessageId).toBe(messageId);
    expect(state?.leaseToken).toBeNull();
  });

  it('retains a failed live trigger so a later worker can finish it', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:true}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    let attempts = 0;
    const reply = async () => { if (++attempts === 1) throw new Error('Temporary reply failure'); };
    await drainCrmAnalyses(db,{model,key,reply});
    const [failed] = await db.select().from(crmAnalyses);
    expect(failed?.status).toBe('failed');
    expect(failed?.pendingLiveMessageId).toBe(messageId);
    expect(failed?.handledLiveMessageId).toBeNull();
    await db.update(crmAnalyses).set({updatedAt:new Date(Date.now()-6*60_000)}).where(eq(crmAnalyses.conversationId,conversationId));
    await drainCrmAnalyses(db,{model,key,reply});
    expect(attempts).toBe(2);
    expect((await db.select().from(crmAnalyses))[0]?.handledLiveMessageId).toBe(messageId);
  });

  it('never treats an imported recent message or an unpersisted live flag as reply authorization', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:true}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    let replies = 0;
    await analyzeConversation(db,{model,key,reply:async()=>{replies++;}},{agentId,conversationId,live:true});
    expect(replies).toBe(0);
  });

  it('preserves a newer pending trigger queued while the prior reply finishes', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:true}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date(Date.now()-1000)}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    let nextId = '';
    const reply = async () => {
      const [next] = await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',body:'Next request',sentAt:new Date()}).returning();
      nextId = next!.id;
      await db.update(crmAnalyses).set({pendingLiveMessageId:nextId}).where(eq(crmAnalyses.conversationId,conversationId));
    };
    await analyzeConversation(db,{model,key,reply},{agentId,conversationId});
    const [state] = await db.select().from(crmAnalyses);
    expect(state?.handledLiveMessageId).toBe(messageId);
    expect(state?.pendingLiveMessageId).toBe(nextId);
    expect(state?.status).toBe('pending');
  });

  it('updates AI-owned custom fields while preserving later operator corrections across scans', async () => {
    const [field] = await db.insert(leadFields).values({agentId,name:'City',kind:'text',position:99}).returning();
    const result = (id:string,value:string) => ({text:JSON.stringify({stageId:null,summary:'Field',confidence:90,
      profile:{},fields:{[field!.id]:{value,messageId:id,quote:value}},checkout:null}),promptTokens:1,completionTokens:1,cost:'0'});
    model.complete.mockResolvedValueOnce(result(messageId,'Алматы'));
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    const [newer] = await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',body:'Астана',sentAt:new Date('2026-02-01')}).returning();
    model.complete.mockResolvedValueOnce(result(newer!.id,'Астана'));
    await analyzeConversation(db,{model,key},{agentId,conversationId});
    expect((await db.select().from(leadValues))[0]?.value).toBe('Астана');
    await db.update(leadValues).set({value:'Operator city',updatedAt:new Date()}).where(eq(leadValues.fieldId,field!.id));
    for (let index=0;index<2;index++) {
      const [later] = await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',body:'Шымкент',sentAt:new Date(Date.UTC(2026,3,index+1))}).returning();
      model.complete.mockResolvedValueOnce(result(later!.id,'Шымкент'));
      await analyzeConversation(db,{model,key},{agentId,conversationId});
    }
    expect((await db.select().from(leadValues))[0]?.value).toBe('Operator city');
  });

  it('renews the lease during a reply that outlasts the initial lease window', async () => {
    await db.update(agents).set({aiEnabled:true}).where(eq(agents.id,agentId));
    await db.update(conversations).set({aiEnabled:true}).where(eq(conversations.id,conversationId));
    await db.update(messages).set({sentAt:new Date()}).where(eq(messages.id,messageId));
    await db.insert(crmAnalyses).values({conversationId,pendingLiveMessageId:messageId});
    vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
    let competingResult: string | undefined;
    try {
      await analyzeConversation(db,{model,key,reply:async()=>{
        await vi.advanceTimersByTimeAsync(125_000);
        competingResult = await analyzeConversation(db,{model,key},{agentId,conversationId,live:true});
      }},{agentId,conversationId});
    } finally { vi.useRealTimers(); }
    expect(competingResult).toBe('skipped');
    expect((await db.select().from(crmAnalyses))[0]?.handledLiveMessageId).toBe(messageId);
  });

});

describe('chat payment', () => {
  const sale = async () => (await db.select().from(stages).where(eq(stages.agentId, agentId))).find((s) => s.kind === 'success')!;
  const paidChat = async () => {
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'phone', kind: 'text',
      body: 'Размер 40 мм — 6.990 тенге', sentAt: new Date('2026-01-01T00:01:00Z') }).returning();
    const [transfer] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
      body: 'Перевела 6990, спасибо', sentAt: new Date('2026-01-01T00:02:00Z') }).returning();
    model.complete.mockResolvedValue({ text: JSON.stringify({ stageId: null, summary: 'Оплатила переводом', confidence: 90, profile: {}, fields: {},
      checkout: null, payment: { state: 'paid', messageId: transfer!.id, quote: 'Перевела 6990', reason: 'Клиент перевёл оплату' },
      paidAmount: { value: '6990', messageId: offer!.id, quote: '6.990 тенге' } }), promptTokens: 1, completionTokens: 1, cost: '0' });
  };

  it('moves a lead that paid by transfer to the sale stage and records one paid order', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conversation?.stageId).toBe((await sale()).id);
    const rows = await db.select().from(orders).where(eq(orders.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '6990.00', status: 'paid', comment: 'Оплата по переписке' });
    expect(rows[0]!.paidAt?.getTime()).toBe(conversation!.stageSetAt!.getTime());
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
    const [analysis] = await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
    expect(analysis?.profile.paymentEvidence).toBe('paid');
  });

  it('does not record a second order when the conversation is analysed again', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Когда отправите?', sentAt: new Date('2026-01-01T00:03:00Z') });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect(await db.select().from(orders)).toHaveLength(1);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
  });

  it('gives an operator-moved sale its order once the amount is found, and never leaves the sale stage', async () => {
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date('2026-01-02T00:00:00Z') }).where(eq(conversations.id, conversationId));
    await paidChat();
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, stageId: targetId, payment: null }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe((await sale()).id);
    expect((await db.select().from(orders))[0]?.paidAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('records no chat order while a Kaspi invoice is pending', async () => {
    await paidChat();
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT' }).returning();
    await db.insert(kaspiPayments).values({ agentId, conversationId, orderId: order!.id, requestKey: 'chat-payment-test', method: 'invoice',
      phone: '77011234567', amount: '6990', status: 'pending' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(orders)).filter((o) => o.status === 'paid')).toHaveLength(0);
  });

  it('records no order when an operator moves the lead out of the sale stage during the model call', async () => {
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date('2026-01-02T00:00:00Z') }).where(eq(conversations.id, conversationId));
    await paidChat();
    const original = model.complete.getMockImplementation()!;
    model.complete.mockImplementationOnce(async (...args: unknown[]) => {
      await db.update(conversations).set({ stageId: targetId, stageSetAt: new Date(), stageSetBy: 'operator' }).where(eq(conversations.id, conversationId));
      return original(...args);
    });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(await db.select().from(orders)).toHaveLength(0);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(0);
  });

  it('does not use the quoted amount when the analysis is unsure', async () => {
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date('2026-01-02T00:00:00Z') }).where(eq(conversations.id, conversationId));
    await paidChat();
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, payment: null, confidence: 50 }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('does not start a Kaspi checkout for a sale already paid in the chat', async () => {
    await db.update(agents).set({ aiEnabled: true }).where(eq(agents.id, agentId));
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text',
      body: 'Итого 5000 ₸', sentAt: new Date(Date.now() - 60_000) }).returning();
    await db.update(messages).set({ body: 'Отправьте счёт, пожалуйста', sentAt: new Date() }).where(eq(messages.id, messageId));
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date(Date.now() - 1000) }).where(eq(conversations.id, conversationId));
    await db.insert(orders).values({ agentId, conversationId, amount: '5000', currency: 'KZT', status: 'paid', comment: 'Оплата по переписке', paidAt: new Date() });
    await db.insert(crmAnalyses).values({ conversationId, pendingLiveMessageId: messageId });
    model.complete.mockResolvedValueOnce({ text: JSON.stringify({ stageId: targetId, summary: 'Хочет оплатить', confidence: 95, profile: {}, fields: {},
      checkout: { method: 'invoice', messageId, quote: 'Отправьте счёт', amount: '5000', amountMessageId: offer!.id } }),
      promptTokens: 1, completionTokens: 1, cost: '0' });
    const checkout = vi.fn(); const reply = vi.fn();
    await analyzeConversation(db, { model, key, checkout, reply }, { agentId, conversationId, live: true });
    expect(checkout).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(agentId, conversationId);
  });

  /** What the leads API does when an operator drags a lead: move it and record the move. */
  const operatorMoves = async (toId: string, movedBy: 'operator' | 'ai' | 'scenario' = 'operator') => {
    const funnel = await db.select().from(stages).where(eq(stages.agentId, agentId));
    const [current] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    const to = funnel.find((s) => s.id === toId)!;
    await db.update(conversations).set({ stageId: to.id, stageSetAt: new Date(), stageSetBy: movedBy }).where(eq(conversations.id, conversationId));
    await recordStageMove(db, { agentId, conversationId, from: funnel.find((s) => s.id === current!.stageId) ?? null, to, movedBy });
  };

  it('leaves a lead an operator took out of the sale stage there, with no second chat order', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe((await sale()).id);
    await operatorMoves(targetId);
    await db.delete(orders).where(eq(orders.conversationId, conversationId));
    expect(await operatorLeftSale(db, conversationId)).toBe(true);
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо!', sentAt: new Date('2026-01-01T00:03:00Z') });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(await db.select().from(orders)).toHaveLength(0);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(false);
  });

  it('still lets the lead move among the other stages after the operator undid the sale', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await operatorMoves(targetId);
    const other = (await db.select().from(stages).where(eq(stages.agentId, agentId))).find((s) => s.kind === 'active' && s.id !== targetId)!;
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, stageId: other.id }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо!', sentAt: new Date('2026-01-01T00:03:00Z') });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe(other.id);
    // The AI's own move does not wipe out the operator's undo.
    expect(await operatorLeftSale(db, conversationId)).toBe(true);
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Жду', sentAt: new Date('2026-01-01T00:04:00Z') });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe(other.id);
  });

  it('moves a lead the operator took out of the sale stage back once Kaspi confirms the money', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await operatorMoves(targetId);
    await db.delete(orders).where(eq(orders.conversationId, conversationId));
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT', status: 'paid', paidAt: new Date() }).returning();
    await db.insert(kaspiPayments).values({ agentId, conversationId, orderId: order!.id, requestKey: 'undo-kaspi', method: 'invoice',
      phone: '77011234567', amount: '6990', status: 'paid', operationId: 'undo-operation', confirmedAt: new Date() });
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Оплатила счёт', sentAt: new Date('2026-01-01T00:03:00Z') });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect((await db.select().from(conversations))[0]?.stageId).toBe((await sale()).id);
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(true);
  });

  it('forgets the undo once an operator puts the lead back into the sale stage', async () => {
    await operatorMoves((await sale()).id);
    expect(await operatorLeftSale(db, conversationId)).toBe(false);
    await operatorMoves(targetId);
    expect(await operatorLeftSale(db, conversationId)).toBe(true);
    await operatorMoves((await sale()).id);
    expect(await operatorLeftSale(db, conversationId)).toBe(false);
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('records a second chat order and Purchase when a customer buys again in a new sale episode', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await tick();
    await operatorMoves(targetId);
    await tick();
    await operatorMoves((await sale()).id);
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'phone', kind: 'text',
      body: 'Второй ремешок — 4.500 тенге', sentAt: new Date(Date.now() + 1000) }).returning();
    const [transfer] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
      body: 'Перевела 4500', sentAt: new Date(Date.now() + 2000) }).returning();
    model.complete.mockResolvedValue({ text: JSON.stringify({ stageId: null, summary: 'Купила ещё раз', confidence: 90, profile: {}, fields: {},
      checkout: null, payment: { state: 'paid', messageId: transfer!.id, quote: 'Перевела 4500', reason: 'Клиент перевёл оплату' },
      paidAmount: { value: '4500', messageId: offer!.id, quote: '4.500 тенге' } }), promptTokens: 1, completionTokens: 1, cost: '0' });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(orders)).map((o) => o.amount).sort()).toEqual(['4500.00', '6990.00']);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(2);

    // Analysed again inside the same episode: still one order for it.
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо', sentAt: new Date(Date.now() + 3000) });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect(await db.select().from(orders)).toHaveLength(2);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(2);
  });

  it('records no second order from the earlier sale\'s messages after the lead goes out of the sale stage and back', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await tick();
    await operatorMoves(targetId);
    await tick();
    await operatorMoves((await sale()).id);
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо', sentAt: new Date(Date.now() + 1000) });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect(await db.select().from(orders)).toHaveLength(1);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
  });

  it('records no second order after out-and-back when the first chat order was backdated to an operator\'s earlier move', async () => {
    // Regression: the operator put the lead into sale before the price and transfer, so the chat order's
    // paid_at is that earlier move; the transfer must still count as the recorded sale's.
    await operatorMoves((await sale()).id);
    await db.update(conversations).set({ stageSetAt: new Date(Date.now() - 10_000) }).where(eq(conversations.id, conversationId));
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'phone', kind: 'text',
      body: 'Размер 40 мм — 6.990 тенге', sentAt: new Date(Date.now() - 9_000) }).returning();
    const [transfer] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
      body: 'Перевела 6990, спасибо', sentAt: new Date(Date.now() - 8_000) }).returning();
    model.complete.mockResolvedValue({ text: JSON.stringify({ stageId: null, summary: 'Оплатила', confidence: 90, profile: {}, fields: {}, checkout: null,
      payment: { state: 'paid', messageId: transfer!.id, quote: 'Перевела 6990', reason: 'Клиент перевёл оплату' },
      paidAmount: { value: '6990', messageId: offer!.id, quote: '6.990 тенге' } }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    const [first] = await db.select().from(orders);
    expect(first!.paidAt!.getTime()).toBeLessThan(transfer!.sentAt.getTime());
    await tick();
    await operatorMoves(targetId);
    await tick();
    await operatorMoves((await sale()).id);
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо', sentAt: new Date() });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect(await db.select().from(orders)).toHaveLength(1);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
  });

  it('does not move a lead back into the sale stage on the earlier sale\'s transfer', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await tick();
    // Not an operator undo: only the age of the evidence stands in the way.
    await operatorMoves(targetId, 'scenario');
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Спасибо', sentAt: new Date(Date.now() + 1000) });

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(await db.select().from(orders)).toHaveLength(1);
    // Nor does the live agent: the stored claim belongs to the sale already recorded.
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(false);
  });

  it('does not record a chat order next to an earlier Kaspi sale from messages that predate it', async () => {
    await paidChat();
    const paidAt = new Date(Date.now() - 60_000);
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT', status: 'paid', paidAt }).returning();
    await db.insert(kaspiPayments).values({ agentId, conversationId, orderId: order!.id, requestKey: 'kaspi-earlier', method: 'invoice',
      phone: '77011234567', amount: '6990', status: 'paid', operationId: 'kaspi-earlier', confirmedAt: paidAt });
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date(), stageSetBy: 'operator' }).where(eq(conversations.id, conversationId));

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it('starts a Kaspi checkout for a repeat customer moved out of the sale stage and back', async () => {
    await db.update(agents).set({ aiEnabled: true }).where(eq(agents.id, agentId));
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text',
      body: 'Итого 5000 ₸', sentAt: new Date(Date.now() - 60_000) }).returning();
    await db.update(messages).set({ body: 'Отправьте счёт, пожалуйста', sentAt: new Date() }).where(eq(messages.id, messageId));
    await db.insert(orders).values({ agentId, conversationId, amount: '5000', currency: 'KZT', status: 'paid', comment: 'Оплата по переписке', paidAt: new Date(Date.now() - 86_400_000) });
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date(Date.now() - 3_600_000) }).where(eq(conversations.id, conversationId));
    await db.insert(crmAnalyses).values({ conversationId, pendingLiveMessageId: messageId });
    model.complete.mockResolvedValueOnce({ text: JSON.stringify({ stageId: null, summary: 'Хочет купить ещё', confidence: 95, profile: {}, fields: {},
      checkout: { method: 'invoice', messageId, quote: 'Отправьте счёт', amount: '5000', amountMessageId: offer!.id } }),
      promptTokens: 1, completionTokens: 1, cost: '0' });
    const checkout = vi.fn(); const reply = vi.fn();
    await analyzeConversation(db, { model, key, checkout, reply }, { agentId, conversationId, live: true });
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('writes a note and still replies when Kaspi refuses the checkout', async () => {
    await db.update(agents).set({ aiEnabled: true }).where(eq(agents.id, agentId));
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text',
      body: 'Итого 5000 ₸', sentAt: new Date(Date.now() - 60_000) }).returning();
    await db.update(messages).set({ body: 'Отправьте счёт, пожалуйста', sentAt: new Date() }).where(eq(messages.id, messageId));
    await db.insert(crmAnalyses).values({ conversationId, pendingLiveMessageId: messageId });
    model.complete.mockResolvedValueOnce({ text: JSON.stringify({ stageId: targetId, summary: 'Хочет оплатить', confidence: 95, profile: {}, fields: {},
      checkout: { method: 'invoice', messageId, quote: 'Отправьте счёт', amount: '5000', amountMessageId: offer!.id } }),
      promptTokens: 1, completionTokens: 1, cost: '0' });
    const checkout = vi.fn().mockRejectedValue(new ApiError(409, 'У сделки уже есть оплаченный заказ')); const reply = vi.fn();

    const result = await analyzeConversation(db, { model, key, checkout, reply }, { agentId, conversationId, live: true });

    expect(result).toBe('ready');
    expect(reply).toHaveBeenCalledWith(agentId, conversationId);
    expect((await db.select().from(notes)).map((n) => n.body)).toEqual(['Счёт Kaspi не создан: У сделки уже есть оплаченный заказ']);
    expect((await db.select().from(crmAnalyses))[0]?.status).not.toBe('failed');
  });

  it('does not return a repeat customer to the sale stage on a Kaspi payment from an earlier sale', async () => {
    const paidAt = new Date(Date.now() - 60_000);
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: paidAt, stageSetBy: 'system' }).where(eq(conversations.id, conversationId));
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT', status: 'paid', paidAt }).returning();
    await db.insert(kaspiPayments).values({ agentId, conversationId, orderId: order!.id, requestKey: 'earlier-sale', method: 'invoice',
      phone: '77011234567', amount: '6990', status: 'paid', operationId: 'earlier-operation', confirmedAt: paidAt });
    await operatorMoves(targetId);

    await analyzeConversation(db, { model, key }, { agentId, conversationId });

    expect((await db.select().from(conversations))[0]?.stageId).toBe(targetId);
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(false);
  });

  it('starts a Kaspi checkout for a repeat customer moved back into work after an earlier paid sale', async () => {
    await db.update(agents).set({ aiEnabled: true }).where(eq(agents.id, agentId));
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text',
      body: 'Итого 5000 ₸', sentAt: new Date(Date.now() - 60_000) }).returning();
    await db.update(messages).set({ body: 'Отправьте счёт, пожалуйста', sentAt: new Date() }).where(eq(messages.id, messageId));
    await db.insert(orders).values({ agentId, conversationId, amount: '5000', currency: 'KZT', status: 'paid', comment: 'Оплата по переписке', paidAt: new Date(Date.now() - 86_400_000) });
    await db.update(conversations).set({ stageId: targetId, stageSetAt: new Date(Date.now() - 3_600_000) }).where(eq(conversations.id, conversationId));
    await db.insert(crmAnalyses).values({ conversationId, pendingLiveMessageId: messageId });
    model.complete.mockResolvedValueOnce({ text: JSON.stringify({ stageId: targetId, summary: 'Хочет купить ещё', confidence: 95, profile: {}, fields: {},
      checkout: { method: 'invoice', messageId, quote: 'Отправьте счёт', amount: '5000', amountMessageId: offer!.id } }),
      promptTokens: 1, completionTokens: 1, cost: '0' });
    const checkout = vi.fn(); const reply = vi.fn();
    await analyzeConversation(db, { model, key, checkout, reply }, { agentId, conversationId, live: true });
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it.each(['paid', 'confirmed'])('treats stored %s payment evidence as visible payment', async (state) => {
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(false);
    await db.insert(crmAnalyses).values({ conversationId, profile: { paymentEvidence: state } });
    expect(await hasVisiblePayment(db, agentId, conversationId)).toBe(true);
  });

  it('does not move on a paid claim below the confidence threshold', async () => {
    await paidChat();
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, confidence: 50 }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).not.toBe((await sale()).id);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});
