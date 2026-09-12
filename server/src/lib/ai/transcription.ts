import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents } from '../../db/schema.js';
import { decryptSecret } from '../secret-box.js';
import type { ModelClient } from './openrouter.js';

/**
 * Turns an inbound voice note into the durable message body used by every later AI turn.
 * The caller owns failure handling so the original media can still be stored when STT fails.
 */
export async function transcribeInboundAudio(
  db: Db,
  deps: { key: Buffer; model: ModelClient },
  agentId: string,
  bytes: Buffer,
  mime: string,
): Promise<string | null> {
  const [agent] = await db
    .select({ openrouterKey: agents.openrouterKey })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent?.openrouterKey) return null;
  if (!deps.model.transcribe) return null;

  const key = decryptSecret(agent.openrouterKey, deps.key, agentId);
  return deps.model.transcribe({ key, bytes, mime });
}
