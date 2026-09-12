import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  agents,
  contacts,
  conversations,
  type AgentResponseMode,
  whatsappNumbers,
} from '../../db/schema.js';

export type AutomationPurpose = 'reply' | 'crm' | 'checkout';

export interface AutomationSnapshot {
  responseMode: AgentResponseMode;
  testContactId: string | null;
  contactId: string;
  conversationAiEnabled: boolean;
  numberEnabled: boolean;
}

export interface AutomationDecision {
  allowed: boolean;
  reason: string;
}

export interface LoadAutomationSnapshotInput {
  agentId: string;
  conversationId: string;
}

export function decideAutomation(
  snapshot: AutomationSnapshot,
  purpose: AutomationPurpose,
): AutomationDecision {
  if (snapshot.responseMode === 'off') return { allowed: false, reason: 'agent_off' };
  if (snapshot.responseMode === 'test' && !snapshot.testContactId) {
    return { allowed: false, reason: 'test_contact_missing' };
  }
  if (snapshot.responseMode === 'test' && snapshot.contactId !== snapshot.testContactId) {
    return { allowed: false, reason: 'test_contact_mismatch' };
  }
  if (!snapshot.conversationAiEnabled) {
    return { allowed: false, reason: 'conversation_disabled' };
  }
  if (purpose === 'reply' && !snapshot.numberEnabled) {
    return { allowed: false, reason: 'number_disabled' };
  }
  return { allowed: true, reason: 'allowed' };
}

export async function loadAutomationSnapshot(
  db: Db,
  input: LoadAutomationSnapshotInput,
): Promise<AutomationSnapshot | null> {
  const selectedContact = alias(contacts, 'automation_test_contact');
  const [snapshot] = await db
    .select({
      responseMode: agents.responseMode,
      testContactId: selectedContact.id,
      contactId: contacts.id,
      conversationAiEnabled: conversations.aiEnabled,
      numberEnabled: whatsappNumbers.enabled,
    })
    .from(agents)
    .innerJoin(
      conversations,
      and(eq(conversations.id, input.conversationId), eq(conversations.agentId, agents.id)),
    )
    .innerJoin(
      contacts,
      and(eq(contacts.id, conversations.contactId), eq(contacts.agentId, agents.id)),
    )
    .innerJoin(
      whatsappNumbers,
      and(
        eq(whatsappNumbers.id, conversations.whatsappNumberId),
        eq(whatsappNumbers.agentId, agents.id),
      ),
    )
    .leftJoin(
      selectedContact,
      and(eq(selectedContact.id, agents.testContactId), eq(selectedContact.agentId, agents.id)),
    )
    .where(eq(agents.id, input.agentId))
    .limit(1);

  return snapshot ?? null;
}
