import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDb } from './helpers/db.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { agents, contacts, conversations, crmAnalyses, leadFields, leadValues, messages, stages, whatsappNumbers } from '../src/db/schema.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { analyzeConversation, drainCrmAnalyses } from '../src/lib/crm/worker.js';

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
  it('classifies old conversations without customer side effects', async () => {
    const checkout = vi.fn();
    await analyzeConversation(db, { model, key, checkout }, { agentId, conversationId });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    const [analysis] = await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
    expect(conversation?.stageId).toBe(targetId);
    expect(conversation?.aiEnabled).toBe(true);
    expect(analysis?.profile).toEqual({ name:'Айгуль',city:'Алматы' });
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
