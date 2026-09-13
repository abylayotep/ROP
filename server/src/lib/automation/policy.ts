import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  agents,
  contacts,
  conversations,
  instagramAccounts,
  type AgentResponseMode,
  whatsappNumbers,
} from '../../db/schema.js';

export type AutomationPurpose = 'reply' | 'crm' | 'checkout';

export interface AutomationSnapshot {
  responseMode: AgentResponseMode;
  crmAnalysisMode: 'follow_ai' | 'independent';
  testContactId: string | null;
  contactId: string;
  conversationAiEnabled: boolean;
  numberEnabled: boolean;
  /**
   * The contact is the agent's own operator alert number.
   *
   * That phone belongs to staff: it receives the handoff alerts, and on the Cloud API it has to
   * write to the number first to open the window they arrive in. Nothing automated may answer
   * it — not a reply, not CRM analysis moving it through the funnel, not a stage template.
   * Read from the agent on every decision rather than stamped once, so setting the number
   * later silences a conversation that already exists.
   */
  operatorContact: boolean;
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
  // First, ahead of independent CRM: the operator is not a lead in any mode.
  if (snapshot.operatorContact) return { allowed: false, reason: 'operator_contact' };
  if (purpose === 'crm' && snapshot.crmAnalysisMode === 'independent') {
    return { allowed: true, reason: 'independent_crm' };
  }
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
      crmAnalysisMode: agents.crmAnalysisMode,
      testContactId: selectedContact.id,
      contactId: contacts.id,
      conversationAiEnabled: conversations.aiEnabled,
      numberEnabled: sql<boolean>`coalesce(${whatsappNumbers.enabled},
        (${instagramAccounts.enabled} and ${instagramAccounts.subscribedAt} is not null), false)`,
      operatorContact: sql<boolean>`coalesce(${contacts.phone} = ${agents.operatorNotifyPhone}, false)`,
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
    .leftJoin(
      whatsappNumbers,
      and(
        eq(whatsappNumbers.id, conversations.whatsappNumberId),
        eq(whatsappNumbers.agentId, agents.id),
      ),
    )
    .leftJoin(
      instagramAccounts,
      and(
        eq(instagramAccounts.id, conversations.instagramAccountId),
        eq(instagramAccounts.agentId, agents.id),
      ),
    )
    .leftJoin(
      selectedContact,
      and(eq(selectedContact.id, agents.testContactId), eq(selectedContact.agentId, agents.id)),
    )
    .where(and(
      eq(agents.id, input.agentId),
      sql`((${conversations.whatsappNumberId} is not null and ${whatsappNumbers.id} is not null)
        or (${conversations.instagramAccountId} is not null and ${instagramAccounts.id} is not null))`,
    ))
    .limit(1);

  return snapshot ?? null;
}
