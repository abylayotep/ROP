import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  decideAutomation,
  loadAutomationSnapshot,
  type AutomationPurpose,
  type AutomationSnapshot,
  type LoadAutomationSnapshotInput,
} from './policy.js';

export type AutomationTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The one serialization point shared by settings changes and automated effects.
 *
 * Transaction-scoped advisory locks are used instead of row locks because an effect can
 * write several tables or call an external provider without touching the agent row. The
 * agent id is namespaced before hashing so this lock cannot overlap another advisory-lock
 * protocol accidentally. Callers must not acquire it twice in the same workflow: compose
 * all work inside the callback instead.
 */
export async function lockAgentAutomation(
  tx: AutomationTransaction,
  agentId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`rakurs:agent-automation:${agentId}`}, 0))`,
  );
}

/** Holds the per-agent lock until the callback and its transaction both finish. */
export function withAgentAutomationLock<T>(
  db: Db,
  agentId: string,
  effect: (tx: AutomationTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockAgentAutomation(tx, agentId);
    return effect(tx);
  });
}

export type AutomationEffectResult<T> =
  | { allowed: true; value: T; snapshot: AutomationSnapshot }
  | { allowed: false; reason: string };

/**
 * Re-authorizes and performs one effect in the same per-agent critical section.
 *
 * Pure database effects should use the supplied transaction for their writes. External
 * effects may await their bounded provider call here; the lock then prevents a successful
 * response-mode PATCH from overtaking a send or checkout that was already authorized.
 */
export function withAutomationEffect<T>(
  db: Db,
  input: LoadAutomationSnapshotInput,
  purpose: AutomationPurpose,
  effect: (
    tx: AutomationTransaction,
    snapshot: AutomationSnapshot,
  ) => Promise<T>,
): Promise<AutomationEffectResult<T>> {
  return withAgentAutomationLock(db, input.agentId, async (tx) => {
    const snapshot = await loadAutomationSnapshot(tx as unknown as Db, input);
    if (!snapshot) return { allowed: false, reason: 'not_found' };
    const decision = decideAutomation(snapshot, purpose);
    if (!decision.allowed) return { allowed: false, reason: decision.reason };
    return { allowed: true, value: await effect(tx, snapshot), snapshot };
  });
}
