import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * Connections one process may hold at once.
 *
 * Written down rather than left to postgres-js's own default of ten, because one route holds
 * a connection for as long as a model takes to think: the sandbox runs a turn inside a
 * transaction it rolls back. Anything that keeps a connection across a slow call has to stay
 * **well below** this number, or the pool empties and every other route — the webhook Meta is
 * waiting on included — queues behind it. `turn-cap.ts`'s shared cap is that limit today,
 * held in common by slow model work and automation advisory-lock users alike — see that file
 * for why it is one counter and not one per feature.
 */
export const POOL_MAX = 10;

/** Does not connect until the first query runs. */
export function createDb(url: string) {
  return drizzle(postgres(url, { max: POOL_MAX }), { schema });
}

export type Db = ReturnType<typeof createDb>;
