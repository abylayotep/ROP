/**
 * Warns the operator before the OpenRouter balance runs out.
 *
 * An empty balance stops everything that calls a model at once: replies, CRM analysis, voice
 * transcription. The first sign used to be a customer left waiting. This sweep reads the
 * balance on a clock and sends the operator's phone a WhatsApp line while there is still
 * money for a day or two of work, then again every day until someone tops it up.
 *
 * Best-effort like the handoff alert: nothing here throws, and a balance that cannot be read
 * is not a reason to warn anybody.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, whatsappNumbers } from '../../db/schema.js';
import { decryptSecret } from '../secret-box.js';
import { markTokenRejected } from '../whatsapp/token-expiry.js';
import { transportFor } from '../whatsapp/transport.js';
import { keyAad, type TurnDeps } from './turn.js';

/** In US dollars. At Sealhouse's volume this is roughly two days of replies and analysis. */
export const LOW_BALANCE_USD = 5;
/** How often the same low balance is repeated while nobody tops it up. */
export const LOW_BALANCE_REPEAT_MS = 24 * 60 * 60_000;
const CREDITS_TIMEOUT_MS = 15_000;

/** What is left on the key's account, in US dollars, or null when it cannot be read. */
export type CreditsReader = (key: string) => Promise<number | null>;

export function createCreditsReader(): CreditsReader {
  return async (key) => {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
      const credits = Number(body.data?.total_credits);
      const usage = Number(body.data?.total_usage);
      return Number.isFinite(credits) && Number.isFinite(usage) ? credits - usage : null;
    } catch {
      return null;
    }
  };
}

/** Operator-facing, so Russian. Pure, so its wording is tested without a socket. */
export function formatLowBalanceAlert(agentName: string, remaining: number): string {
  const left = `$${Math.max(remaining, 0).toFixed(2)}`;
  const head = remaining <= 0.05
    ? `Баланс OpenRouter закончился (${left}). ИИ «${agentName}» не отвечает клиентам и не разбирает чаты.`
    : `Баланс OpenRouter заканчивается: осталось ${left}. Когда он кончится, ИИ «${agentName}» перестанет отвечать клиентам и разбирать чаты.`;
  return `${head}\nПополните: https://openrouter.ai/settings/credits`;
}

export interface BalanceDeps extends Pick<TurnDeps, 'graph' | 'linked' | 'key'> {
  readCredits: CreditsReader;
}

/** One pass over every agent that has both a key and a phone to warn. Returns failures, key-free. */
export async function checkOpenRouterBalances(db: Db, deps: BalanceDeps, now = new Date()): Promise<string[]> {
  const errors: string[] = [];
  const rows = await db.select().from(agents)
    .where(and(isNotNull(agents.openrouterKey), isNotNull(agents.operatorNotifyPhone)));

  for (const agent of rows) {
    try {
      const key = decryptSecret(agent.openrouterKey!, deps.key, keyAad(agent.id));
      const remaining = await deps.readCredits(key);
      if (remaining === null) continue;

      if (remaining >= LOW_BALANCE_USD) {
        if (agent.lowBalanceAlertedAt !== null) {
          await db.update(agents).set({ lowBalanceAlertedAt: null }).where(eq(agents.id, agent.id));
        }
        continue;
      }
      const last = agent.lowBalanceAlertedAt?.getTime();
      if (last !== undefined && now.getTime() - last < LOW_BALANCE_REPEAT_MS) continue;

      const [number] = await db.select().from(whatsappNumbers)
        .where(and(eq(whatsappNumbers.agentId, agent.id), eq(whatsappNumbers.enabled, true)))
        .orderBy(asc(whatsappNumbers.createdAt))
        .limit(1);
      if (!number) continue;

      const transport = transportFor(number, {
        graph: deps.graph,
        linked: deps.linked,
        key: deps.key,
        onTokenRejected: () => markTokenRejected(db, number.id),
      });
      await transport.sendText(agent.operatorNotifyPhone!, formatLowBalanceAlert(agent.name, remaining));
      await db.update(agents).set({ lowBalanceAlertedAt: now }).where(eq(agents.id, agent.id));
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      errors.push(`balance alert for agent ${agent.id} failed: ${said.slice(0, 200)}`);
    }
  }
  return errors;
}
