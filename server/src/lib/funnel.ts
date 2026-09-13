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

export interface DefaultStage {
  name: string;
  color: string;
  kind: StageKind;
  /** When a conversation belongs on this stage. Read by the CRM analysis. */
  description: string;
  /** What the agent does while a conversation is here. Read by the reply prompt. */
  agentGoal: string;
}

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
 *
 * The goals are the sales script. Without them the agent had no idea which step of the sale
 * it was on, and answered a customer's first «здравствуйте» by asking whether they were
 * ordering. Each goal says what to do on the stage and, where it matters, what not to do yet.
 * The Russian text is read by the model and shown to the owner, who may rewrite it.
 */
export const DEFAULT_STAGES: DefaultStage[] = [
  {
    name: 'Новый лид', color: '#8a94a6', kind: 'active',
    description: 'Клиент только написал: поздоровался или задал первый вопрос. Что ему нужно, ещё не ясно.',
    agentGoal: 'Поздоровайся и узнай, что нужно клиенту. Если он сразу задал вопрос — ответь на него и задай один уточняющий вопрос о его задаче. Не спрашивай, будет ли заказ, и не говори об оплате.',
  },
  {
    name: 'В диалоге', color: '#4b8ef0', kind: 'active',
    description: 'Клиент отвечает и рассказывает, что ему нужно, но конкретный товар или вариант ещё не выбран.',
    agentGoal: 'Выясни потребность: что именно нужно, для чего, какой вариант. Отвечай на вопросы клиента по базе знаний. О заказе и оплате не спрашивай.',
  },
  {
    name: 'Интерес проявлен', color: '#4b8ef0', kind: 'active',
    description: 'Клиент спрашивает о конкретном товаре или услуге: цена, сроки, доставка, варианты.',
    agentGoal: 'Ответь на вопрос клиента и помоги выбрать подходящий вариант. Уточняй недостающее по одному вопросу. О заказе и оплате пока не спрашивай.',
  },
  {
    name: 'Квалифицирован', color: '#7b61ff', kind: 'qualified',
    description: 'Понятно, что именно нужно клиенту: товар или вариант, количество, город.',
    agentGoal: 'Предложи конкретный вариант с ценой из базы знаний и спроси, подходит ли он клиенту.',
  },
  {
    name: 'Предложение отправлено', color: '#e0a13a', kind: 'active',
    description: 'Клиенту назвали конкретный вариант и цену, он думает или задаёт вопросы.',
    agentGoal: 'Ответь на сомнения и вопросы. Когда клиенту всё подходит — спроси, оформляем ли заказ.',
  },
  {
    name: 'Готов к покупке', color: '#e0a13a', kind: 'active',
    description: 'Клиент сказал, что берёт, и согласовал, что именно заказывает.',
    agentGoal: 'Подтверди состав заказа, назови итоговую сумму и уточни данные для доставки. Затем предложи способ оплаты.',
  },
  {
    name: 'Заказано', color: '#e0a13a', kind: 'awaiting_payment',
    description: 'Заказ согласован, клиенту дали способ оплаты, ждём оплату.',
    agentGoal: 'Помоги клиенту оплатить по инструкциям владельца. Никогда не говори, что оплата получена.',
  },
  {
    name: 'Оплачено', color: '#0d9668', kind: 'success',
    description: 'Оплата подтверждена.',
    agentGoal: 'Поблагодари клиента и расскажи, что будет дальше: сроки и получение заказа.',
  },
  {
    name: 'Отказ', color: '#d24b4b', kind: 'failure',
    description: 'Клиент отказался от покупки.',
    agentGoal: 'Вежливо прими решение клиента, можно спросить причину. Не дави и не уговаривай.',
  },
];

/** The default goal for a stage the owner has not given one, matched by its default name. */
export function defaultStageGoal(name: string): string {
  return DEFAULT_STAGES.find((stage) => stage.name === name.trim())?.agentGoal ?? '';
}

/** Writes the default funnel for an agent that has just been created. */
export async function seedFunnel(db: Executor, agentId: string): Promise<void> {
  await db.insert(stages).values(
    DEFAULT_STAGES.map((stage, position) => ({ agentId, position, ...stage })),
  );
}
