/**
 * The owner's sales script, as the reply turn and the API read it.
 *
 * The prompt tells the model which step it is on; this file holds the few decisions that must
 * not depend on the model obeying — which step may follow which while payment is unconfirmed,
 * and which photos belong to the part of the sale that comes after payment. A «ждать оплату»
 * step whose only guard is a sentence in the prompt is a finished product sent to a customer
 * who has not paid, so both are checked in code as well.
 */
import { asc, eq } from 'drizzle-orm';
import type { ScriptStep } from '@rakurs/contract';
import { salesScriptSteps } from '../../db/schema.js';
import type { Executor } from '../funnel.js';

/** How many steps one agent's script may hold, branches included. */
export const SCRIPT_STEP_LIMIT = 40;
export const SCRIPT_TITLE_MAX = 80;
export const SCRIPT_CONDITION_MAX = 200;
export const SCRIPT_INSTRUCTIONS_MAX = 2000;
export const SCRIPT_HANDOFF_NOTE_MAX = 200;
/** Matches `PHOTO_SEND_LIMIT`: a step's photos go out on one reply. */
export const SCRIPT_STEP_PHOTOS = 4;
export const SCRIPT_STEP_FIELDS = 10;

export type ScriptStepRow = typeof salesScriptSteps.$inferSelect;

export const toScriptStep = (row: ScriptStepRow): ScriptStep => ({
  id: row.id,
  parentId: row.parentId,
  position: row.position,
  title: row.title,
  condition: row.condition,
  instructions: row.instructions,
  stageId: row.stageId,
  photoIds: row.photoIds,
  fieldIds: row.fieldIds,
  handoff: row.handoff,
  handoffNote: row.handoffNote,
  waitPayment: row.waitPayment,
});

/**
 * Main-chain steps in order, each followed by its own branches in order.
 *
 * The one order everything reads the script in — the editor, the prompt's numbering, the
 * payment gate — so «шаг 3» means the same step on the screen and in the model's instructions.
 * A branch whose parent is somehow missing is dropped rather than promoted: the API never
 * leaves one, and a stray branch shown as a main step would change the order of the sale.
 */
export function orderScript<T extends { id: string; parentId: string | null; position: number }>(
  rows: readonly T[],
): T[] {
  const byPosition = (a: T, b: T) => a.position - b.position;
  const roots = rows.filter((row) => row.parentId === null).sort(byPosition);
  return roots.flatMap((root) => [
    root,
    ...rows.filter((row) => row.parentId === root.id).sort(byPosition),
  ]);
}

export async function loadScript(db: Executor, agentId: string): Promise<ScriptStepRow[]> {
  const rows = await db.select().from(salesScriptSteps)
    .where(eq(salesScriptSteps.agentId, agentId))
    .orderBy(asc(salesScriptSteps.position));
  return orderScript(rows);
}

type GateStep = Pick<ScriptStepRow, 'id' | 'parentId' | 'photoIds' | 'waitPayment'>;

/** Each step's place in the main chain: a branch shares its parent's. */
function chainIndex(script: readonly GateStep[]): Map<string, number> {
  const index = new Map<string, number>();
  let root = -1;
  for (const step of script) {
    if (step.parentId === null) root += 1;
    index.set(step.id, root);
  }
  return index;
}

/**
 * True when moving from `current` to `target` would pass a «ждать оплату» step.
 *
 * Measured on the main chain: a branch of the payment step («если спросит про рассрочку») is
 * still that step, and going back is always allowed. A conversation with no step yet counts
 * as standing before the first one, so an unpaid customer cannot be dropped straight onto the
 * step after payment either.
 */
export function passesUnpaidPayment(
  script: readonly GateStep[],
  currentId: string | null,
  targetId: string,
): boolean {
  const index = chainIndex(script);
  const target = index.get(targetId);
  if (target === undefined) return false;
  const from = currentId === null ? 0 : index.get(currentId) ?? 0;
  return script.some((step) => {
    if (!step.waitPayment) return false;
    const at = index.get(step.id)!;
    return at >= from && target > at;
  });
}

/**
 * Photos that belong only to the part of the sale after the first «ждать оплату» step — the
 * finished product, the receipt, whatever the owner put there. Not sent while payment is
 * unconfirmed, whatever the model asks for; a photo also listed on an earlier step is not
 * one of them, since the owner has already chosen to show it before payment.
 */
export function afterPaymentPhotoIds(script: readonly GateStep[]): Set<string> {
  const index = chainIndex(script);
  const waits = script.filter((step) => step.waitPayment).map((step) => index.get(step.id)!);
  if (waits.length === 0) return new Set();
  const gate = Math.min(...waits);
  const before = new Set(script.filter((step) => index.get(step.id)! <= gate).flatMap((step) => step.photoIds));
  return new Set(script.filter((step) => index.get(step.id)! > gate)
    .flatMap((step) => step.photoIds).filter((id) => !before.has(id)));
}
