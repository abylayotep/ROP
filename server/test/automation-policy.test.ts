import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decideAutomation,
  loadAutomationSnapshot,
  type AutomationPurpose,
  type AutomationSnapshot,
} from '../src/lib/automation/policy.js';
import { accounts, agents, contacts, conversations, whatsappNumbers } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

const base: AutomationSnapshot = {
  responseMode: 'live',
  crmAnalysisMode: 'follow_ai',
  testContactId: null,
  contactId: 'contact-a',
  conversationAiEnabled: true,
  numberEnabled: true,
};

describe('automation policy', () => {
  it.each<{
    name: string;
    snapshot: AutomationSnapshot;
    purpose: AutomationPurpose;
    expected: { allowed: boolean; reason: string };
  }>([
    {
      name: 'rejects an agent whose response mode is off',
      snapshot: { ...base, responseMode: 'off' },
      purpose: 'reply',
      expected: { allowed: false, reason: 'agent_off' },
    },
    {
      name: 'allows a live reply',
      snapshot: base,
      purpose: 'reply',
      expected: { allowed: true, reason: 'allowed' },
    },
    {
      name: 'allows the selected contact in test mode',
      snapshot: { ...base, responseMode: 'test', testContactId: 'contact-a' },
      purpose: 'reply',
      expected: { allowed: true, reason: 'allowed' },
    },
    {
      name: 'rejects another contact in test mode',
      snapshot: { ...base, responseMode: 'test', testContactId: 'contact-b' },
      purpose: 'reply',
      expected: { allowed: false, reason: 'test_contact_mismatch' },
    },
    {
      name: 'rejects test mode without a selected contact',
      snapshot: { ...base, responseMode: 'test' },
      purpose: 'reply',
      expected: { allowed: false, reason: 'test_contact_missing' },
    },
    {
      name: 'rejects a disabled conversation',
      snapshot: { ...base, conversationAiEnabled: false },
      purpose: 'crm',
      expected: { allowed: false, reason: 'conversation_disabled' },
    },
    {
      name: 'allows independent CRM with replies off and conversation AI disabled',
      snapshot: { ...base, crmAnalysisMode: 'independent', responseMode: 'off', conversationAiEnabled: false },
      purpose: 'crm',
      expected: { allowed: true, reason: 'independent_crm' },
    },
    {
      name: 'keeps checkout disabled when CRM is independent',
      snapshot: { ...base, crmAnalysisMode: 'independent', responseMode: 'off' },
      purpose: 'checkout',
      expected: { allowed: false, reason: 'agent_off' },
    },
    {
      name: 'rejects a reply through a disabled WhatsApp number',
      snapshot: { ...base, numberEnabled: false },
      purpose: 'reply',
      expected: { allowed: false, reason: 'number_disabled' },
    },
    {
      name: 'allows CRM work through a disabled WhatsApp number',
      snapshot: { ...base, numberEnabled: false },
      purpose: 'crm',
      expected: { allowed: true, reason: 'allowed' },
    },
    {
      name: 'allows checkout work through a disabled WhatsApp number',
      snapshot: { ...base, numberEnabled: false },
      purpose: 'checkout',
      expected: { allowed: true, reason: 'allowed' },
    },
  ])('$name', ({ snapshot, purpose, expected }) => {
    expect(decideAutomation(snapshot, purpose)).toEqual(expected);
  });
});

describe('automation snapshot loader', () => {
  let db: Awaited<ReturnType<typeof withDb>>;
  let own: Awaited<ReturnType<typeof seedAutomationGraph>>;
  let foreign: Awaited<ReturnType<typeof seedAutomationGraph>>;

  beforeEach(async () => {
    db = await withDb();
    own = await seedAutomationGraph(db, 'own');
    foreign = await seedAutomationGraph(db, 'foreign');
  });

  it('loads one complete snapshot for the requested agent conversation', async () => {
    const snapshot = await loadAutomationSnapshot(db, {
      agentId: own.agentId,
      conversationId: own.conversationId,
    });

    expect(snapshot).toEqual({
      responseMode: 'live',
      crmAnalysisMode: 'follow_ai',
      testContactId: own.contactId,
      contactId: own.contactId,
      conversationAiEnabled: true,
      numberEnabled: true,
    });
  });

  it('does not load a conversation through another agent scope', async () => {
    const snapshot = await loadAutomationSnapshot(db, {
      agentId: foreign.agentId,
      conversationId: own.conversationId,
    });

    expect(snapshot).toBeNull();
  });

  it('rejects a conversation linked to another agent contact', async () => {
    await expect(db
      .update(conversations)
      .set({ contactId: foreign.contactId })
      .where(eq(conversations.id, own.conversationId))).rejects.toThrow();
  });

  it('does not load a conversation linked to another agent number', async () => {
    await db
      .update(conversations)
      .set({ whatsappNumberId: foreign.numberId })
      .where(eq(conversations.id, own.conversationId));

    const snapshot = await loadAutomationSnapshot(db, {
      agentId: own.agentId,
      conversationId: own.conversationId,
    });

    expect(snapshot).toBeNull();
  });

  it('treats a foreign selected test contact as missing', async () => {
    await db
      .update(agents)
      .set({ responseMode: 'test', testContactId: foreign.contactId })
      .where(eq(agents.id, own.agentId));

    const snapshot = await loadAutomationSnapshot(db, {
      agentId: own.agentId,
      conversationId: own.conversationId,
    });

    expect(snapshot?.testContactId).toBeNull();
    expect(decideAutomation(snapshot!, 'reply')).toEqual({
      allowed: false,
      reason: 'test_contact_missing',
    });
  });

  it('treats a deleted selected test contact as missing', async () => {
    const [selected] = await db
      .insert(contacts)
      .values({ agentId: own.agentId, phone: '77000000003' })
      .returning({ id: contacts.id });
    await db
      .update(agents)
      .set({ responseMode: 'test', testContactId: selected!.id })
      .where(eq(agents.id, own.agentId));
    await db.delete(contacts).where(eq(contacts.id, selected!.id));

    const snapshot = await loadAutomationSnapshot(db, {
      agentId: own.agentId,
      conversationId: own.conversationId,
    });

    expect(snapshot?.testContactId).toBeNull();
    expect(decideAutomation(snapshot!, 'reply')).toEqual({
      allowed: false,
      reason: 'test_contact_missing',
    });
  });
});

async function seedAutomationGraph(
  db: Awaited<ReturnType<typeof withDb>>,
  label: string,
) {
  const [account] = await db.insert(accounts).values({ name: label }).returning({ id: accounts.id });
  const [agent] = await db
    .insert(agents)
    .values({ accountId: account!.id, name: label, responseMode: 'live' })
    .returning({ id: agents.id });
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      connectionKind: 'linked',
      linkedJid: `${label}@s.whatsapp.net`,
      linkedState: 'open',
      displayPhone: label,
    })
    .returning({ id: whatsappNumbers.id });
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, phone: label })
    .returning({ id: contacts.id });
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent!.id,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
    })
    .returning({ id: conversations.id });
  await db.update(agents).set({ testContactId: contact!.id }).where(eq(agents.id, agent!.id));
  return {
    agentId: agent!.id,
    contactId: contact!.id,
    conversationId: conversation!.id,
    numberId: number!.id,
  };
}
