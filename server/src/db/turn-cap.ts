import { POOL_MAX } from './client.js';

/**
 * How many operations that hold a database connection across slow or contended work may run at
 * once, across the whole process — and the one counter every such operation shares to enforce it.
 *
 * A turn like this holds a connection for as long as the model thinks — up to the client's
 * sixty-second deadline — because the transaction it rolls back (the sandbox) or the row it
 * writes before and after the call (the coach) is what keeps the turn honest while the model
 * is away. Connections are `POOL_MAX` and shared with every other route, so without a cap a
 * handful of owners clicking «Проверить» or coaching the agent at once empties the pool and
 * the webhook Meta is waiting on queues behind them for a minute.
 *
 * Three is the intent, and the pool is the ceiling: written against `POOL_MAX` so that
 * shrinking the pool cannot silently make this cap the larger of the two.
 *
 * Floored at one, because the ceiling can reach zero. A pool configured at two or less makes
 * `POOL_MAX - 2` zero or negative, and a cap of zero is not a small sandbox — it is one that
 * answers 429 to every owner, always, for a reason nothing on the screen explains. Better one
 * at a time on a pool that small than none at all.
 *
 * The rate limit does not do this job. Twenty a minute is above the pool size to begin with,
 * and a count per minute says nothing about how many are in flight at one instant.
 *
 * The counter below is process-wide and shared by every feature shaped this way — the
 * sandbox (`api/ai.ts`), coach (`api/coach.ts`), and automation advisory-lock users today. It is
 * deliberately one counter, not one per feature: what the pool feels is how many connections
 * are held at once, not which feature is holding them. Automation admission happens before its
 * transaction, leaving pool capacity for independently committed provider intents and other
 * root-pool work reached from inside the locked callback. Any future path with this shape joins
 * this counter rather than starting a feature-local one.
 */
export const sandboxTurns = (poolMax: number): number => Math.max(1, Math.min(3, poolMax - 2));

export const SANDBOX_TURNS = sandboxTurns(POOL_MAX);

/**
 * How many of these turns are in flight now, across every feature that shares the cap above.
 * Module-level rather than per-server, because what it protects — the connection pool —
 * belongs to the process, and a second `buildServer` in one process would share the pool
 * without sharing a counter.
 */
let turnsInFlight = 0;

/**
 * Takes a slot and reports whether there was one to take. The caller decides how to answer a
 * `false` — the sandbox and the coach each have their own 429 wording — this module only
 * owns whether a slot exists.
 */
export function tryTakeTurnSlot(): boolean {
  if (turnsInFlight >= SANDBOX_TURNS) return false;
  turnsInFlight += 1;
  return true;
}

/** Gives a slot back. Call from a `finally`, so a turn that raises does not leave the pool
 * one slot poorer for the life of the process. */
export function releaseTurnSlot(): void {
  turnsInFlight -= 1;
}

/**
 * Whether at least one slot is held anywhere in the process right now.
 *
 * Not "did *this* caller take one" — the counter above has no notion of who holds what, only
 * how many. That is enough for what this answers: a function that must never run without a
 * slot already held (`replayCase`, which holds a database connection across a model call the
 * same way every other caller of this module does) can assert this at its own top and catch
 * a caller that forgot `tryTakeTurnSlot` in the first test that exercises it, instead of
 * finding out under load that the pool has no cap protecting it there at all.
 *
 * A concurrent, unrelated slot would make this pass even for a caller that itself forgot —
 * that gap is real, but closing it needs a token handed back from `tryTakeTurnSlot` and
 * threaded through every caller, which is a bigger change than an assertion meant to catch a
 * caller that forgot is worth. Every test that exercises `replayCase` today runs alone against
 * this counter, so the gap does not hide anything in practice.
 */
export function turnSlotHeld(): boolean {
  return turnsInFlight >= 1;
}

/**
 * Whether a slot is free right now — a peek, not a reservation.
 *
 * `api/drafts.ts`'s run route uses this once, at the door, before it writes a single row: if
 * the pool already reads full, refusing there costs the owner nothing. It is deliberately not
 * a reservation — nothing here is held between this call and the real, per-call
 * `tryTakeTurnSlot`/`takeTurnSlotWaiting` below, so two callers can both see a slot free and
 * both proceed. That race is fine for what this answers: an admission heuristic that only ever
 * needs to catch the common case (the pool is visibly saturated *before* a run even starts),
 * not to guarantee a slot is still there a moment later — the real cap is enforced where it has
 * always been enforced, per call.
 */
export function turnSlotAvailable(): boolean {
  return turnsInFlight < SANDBOX_TURNS;
}

/**
 * How long a call already admitted into a run waits for a slot before giving up — or, with no
 * bound given at all, for as long as it takes.
 *
 * This used to default to `TIMEOUT_MS` (`lib/ai/openrouter.ts`) on the premise that whoever
 * holds "your" slot right now can run for at most one model call's own worst case before it
 * times out on its own. That premise was false: a slot here is held for an entire `replayCase`
 * call, not one model call — every message in a case, up to two attempts each, each attempt up
 * to `TIMEOUT_MS` on its own — so a holder's true ceiling is that multiplied by however many
 * messages the case it is replaying happens to have, a number nothing in this module (or the
 * schema `test_cases.messages` is stored in) bounds. A 60-second wait timed out on a holder
 * that was never going to be done in 60 seconds, refusing a run for a reason that had nothing
 * to do with anything actually wrong.
 *
 * `api/drafts.ts`'s run route is the one caller, and it now answers its own HTTP request
 * before this is ever called — see that file's header comment. Nothing is waiting on this
 * finishing quickly any more, so there is nothing left to bound the wait against: called with
 * no `timeoutMs` at all, this waits for as long as the run it belongs to is alive, which is
 * exactly as long as it should. `timeoutMs` stays a parameter, not deleted, for a caller that
 * genuinely does have something to bound the wait by — none exists today — and the three tests
 * below exercise both an explicit bound and the unbounded default.
 */
export async function takeTurnSlotWaiting(timeoutMs?: number): Promise<boolean> {
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  for (;;) {
    if (tryTakeTurnSlot()) return true;
    if (deadline !== null && Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
