import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents } from '../../db/schema.js';

/**
 * Mark that this agent would now answer differently.
 *
 * Called inside the same transaction as the write it describes, never after it: a version that
 * lags its data is worse than no version at all, because it makes a stale baseline look fresh
 * and a draft tested against yesterday's store look proven.
 */
export async function bumpConfigVersion(tx: Db, agentId: string): Promise<number> {
  const [row] = await tx
    .update(agents)
    .set({ configVersion: sql`${agents.configVersion} + 1` })
    .where(eq(agents.id, agentId))
    .returning({ version: agents.configVersion });
  return row!.version;
}
