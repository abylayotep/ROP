import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { agents, contacts, conversations, crmAnalyses, kaspiPayments, messages, orders, whatsappNumbers } from '../src/db/schema.js';
import { createCrmDeps, createLiveCrmHandler } from '../src/lib/crm/live.js';
import { createKaspiCheckout } from '../src/lib/kaspi/service.js';
vi.mock('../src/lib/kaspi/service.js',async (original)=>({...await original<typeof import('../src/lib/kaspi/service.js')>(),createKaspiCheckout:vi.fn()}));
let db: Awaited<ReturnType<typeof withDb>>;
let paymentId:string;let orderId:string;let agentId:string;let conversationId:string;let messageId:string;let numberId:string;let dir:string;
const linked=fakeLinked();const key=Buffer.alloc(32,7);const model={complete:vi.fn()};
const deps={model,key,linked,graph:fakeGraph()};
beforeEach(async()=>{
  db=await withDb();vi.mocked(createKaspiCheckout).mockReset();model.complete.mockReset();linked.calls.length=0;
  dir=await mkdtemp(join(tmpdir(),'rop-crm-live-'));
  const {accountId}=await createAccountWithOwner(db,{company:'Live test',email:'live@example.com',name:'Owner',initials:'LT',password:'password-live-test'});
  const [agent]=await db.insert(agents).values({accountId,name:'Live',aiEnabled:true,openrouterKey:'configured'}).returning();agentId=agent!.id;
  const [number]=await db.insert(whatsappNumbers).values({agentId,connectionKind:'linked',linkedState:'open',linkedJid:'77010000000@s.whatsapp.net',displayPhone:'77010000000',enabled:true}).returning();numberId=number!.id;linked.setOpen(numberId,true);
  const [contact]=await db.insert(contacts).values({agentId,phone:'77011234567'}).returning();
  const [conversation]=await db.insert(conversations).values({agentId,contactId:contact!.id,whatsappNumberId:numberId,aiEnabled:true,lastInboundAt:new Date()}).returning();conversationId=conversation!.id;
  const [message]=await db.insert(messages).values({conversationId,direction:'in',author:'client',kind:'text',body:'Отправьте счёт',sentAt:new Date()}).returning();messageId=message!.id;
  const [order] = await db.insert(orders).values({agentId,conversationId,amount:'5000',currency:'KZT'}).returning();orderId=order!.id;
  const [payment] = await db.insert(kaspiPayments).values({agentId,conversationId,orderId,amount:'5000',phone:'77011234567',method:'invoice',requestKey:'test',status:'pending',operationId:'123'}).returning();paymentId=payment!.id;
  vi.mocked(createKaspiCheckout).mockResolvedValue({id:paymentId,orderId,conversationId,method:'invoice',phone:'77011234567',amount:'5000',status:'pending',operationId:'123',qrToken:null,paymentUrl:null,error:null,confirmedAt:null});
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const input=(method:'invoice'|'qr'='invoice')=>({agentId,conversationId,phone:'77019999999',summary:'Два фильтра',intent:{method,messageId,quote:'Отправьте счёт',amount:'5000',amountMessageId:'seller'}});
it('issues a phone invoice to the actual contact and records one text notification',async()=>{
  await createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input());
  expect(vi.mocked(createKaspiCheckout).mock.calls[0]?.[2]).toMatchObject({phone:'77011234567',method:'invoice',requestKey:`crm:${messageId}`});
  expect(linked.calls.filter(c=>c.method==='sendText')).toHaveLength(1);
  expect(linked.calls.filter(c=>c.method==='sendMedia')).toHaveLength(0);
  expect((await db.select().from(messages)).filter(m=>m.author==='ai')).toHaveLength(1);
});
it('sends QR as an actual PNG without sending a phone-invoice text',async()=>{
  vi.mocked(createKaspiCheckout).mockResolvedValue({id:paymentId,orderId,conversationId,method:'qr',phone:'',amount:'5000',status:'pending',operationId:'123',qrToken:'https://pay.kaspi.kz/pay/demo',paymentUrl:null,error:null,confirmedAt:null});
  await createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input('qr'));
  expect(linked.calls.filter(c=>c.method==='sendText')).toHaveLength(0);
  expect(linked.calls.filter(c=>c.method==='sendMedia')).toHaveLength(1);
  const [sent]=(await db.select().from(messages)).filter(m=>m.author==='ai');
  expect(sent?.kind).toBe('image');
  const bytes=await readFile(join(dir,sent!.mediaPath!));expect(bytes.subarray(1,4).toString()).toBe('PNG');
});
it('never tells the client an ambiguous invoice was sent successfully',async()=>{
  vi.mocked(createKaspiCheckout).mockResolvedValue({id:paymentId,orderId,conversationId,method:'invoice',phone:'77011234567',amount:'5000',status:'unknown',operationId:null,qrToken:null,paymentUrl:null,error:'Unknown',confirmedAt:null});
  await expect(createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input())).rejects.toThrow();
  expect(linked.calls.filter(c=>c.method==='sendText'||c.method==='sendMedia')).toHaveLength(0);
});
it('persists a live trigger when a history worker already holds the lease',async()=>{
  await db.insert(crmAnalyses).values({conversationId,status:'running',leaseToken:'cec45a20-4c65-451a-896f-1139d6e2a9bb',leaseUntil:new Date(Date.now()+60000)});
  expect(await createLiveCrmHandler(db,testEnv({MEDIA_DIR:dir}),deps)(agentId,conversationId)).toBe(true);
  const [analysis]=await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId,conversationId));
  expect(analysis?.pendingLiveMessageId).toBe(messageId);
  expect(model.complete).not.toHaveBeenCalled();
});

it('claims one notification across concurrent handlers and a restarted handler',async()=>{
  const callback=createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!;
  await Promise.all([callback(input()),callback(input())]);
  expect(linked.calls.filter(c=>c.method==='sendText')).toHaveLength(1);
  const [payment]=await db.select().from(kaspiPayments).where(eq(kaspiPayments.id,paymentId));
  expect(payment?.notificationStatus).toBe('sent');
  expect(payment?.notificationMessageId).toBeTruthy();
  // Even if transcript retention removes the outbound line, the payment keeps its claim.
  await db.delete(messages).where(eq(messages.author,'ai'));
  await createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input());
  expect(linked.calls.filter(c=>c.method==='sendText')).toHaveLength(1);
});
it('keeps a durable unknown claim after an ambiguous external send and never retries',async()=>{
  const send=vi.spyOn(linked,'sendText').mockRejectedValueOnce(new Error('connection lost after send'));
  try {
    await expect(createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input())).rejects.toThrow();
    expect((await db.select().from(kaspiPayments))[0]?.notificationStatus).toBe('unknown');
    await createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input());
    expect(send).toHaveBeenCalledTimes(1);
  } finally { send.mockRestore(); }
});
it('does not resend a QR whose previous process already claimed delivery',async()=>{
  await db.update(kaspiPayments).set({notificationStatus:'unknown',notificationClaimedAt:new Date()}).where(eq(kaspiPayments.id,paymentId));
  vi.mocked(createKaspiCheckout).mockResolvedValue({id:paymentId,orderId,conversationId,method:'qr',phone:'',amount:'5000',status:'pending',operationId:'123',qrToken:'https://pay.kaspi.kz/pay/demo',paymentUrl:null,error:null,confirmedAt:null});
  await createCrmDeps(db,testEnv({MEDIA_DIR:dir}),deps).checkout!(input('qr'));
  expect(linked.calls.filter(c=>c.method==='sendMedia')).toHaveLength(0);
});
