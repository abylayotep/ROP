import type { StageKind } from '@rakurs/contract';
import type { Db } from '../db/client.js';
import { stages } from '../db/schema.js';

/**
 * A database handle or an open transaction.
 *
 * Drizzle gives the transaction callback a different type from the connection, and
 * seeding has to run inside the transaction that creates the agent.
 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The funnel a new agent starts with.
 *
 * Nine stages because that is the shape of a sale someone actually runs: a lead arrives,
 * is talked to, is qualified, is quoted, is invoiced, and then either buys or does not.
 * The owner reshapes it afterwards; this exists so the board is never blank on day one.
 *
 * Exactly one stage has kind `success`. Everything downstream — the statistics of stage 7
 * and the ad events of stage 6 — asks "did this lead reach the sale", and two answers to
 * that question is the confusion this constant refuses to create.
 */
export const DEFAULT_STAGES: { name: string; color: string; kind: StageKind }[] = [
  { name: 'Новый лид', color: '#8a94a6', kind: 'active' },
  { name: 'В диалоге', color: '#4b8ef0', kind: 'active' },
  { name: 'Интерес проявлен', color: '#4b8ef0', kind: 'active' },
  { name: 'Квалифицирован', color: '#7b61ff', kind: 'qualified' },
  { name: 'Предложение отправлено', color: '#e0a13a', kind: 'active' },
  { name: 'Готов к покупке', color: '#e0a13a', kind: 'active' },
  { name: 'Счёт отправлен', color: '#e0a13a', kind: 'awaiting_payment' },
  { name: 'Продажа', color: '#0d9668', kind: 'success' },
  { name: 'Отказ', color: '#d24b4b', kind: 'failure' },
];

/** Writes the default funnel for an agent that has just been created. */
export async function seedFunnel(db: Executor, agentId: string): Promise<void> {
  await db.insert(stages).values(
    DEFAULT_STAGES.map((stage, position) => ({ agentId, position, ...stage })),
  );
}
