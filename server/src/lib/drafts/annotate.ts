/**
 * The annotation: one model call per case, comparing «было», «стало» and what the owner said
 * they expected, and returning a one-word verdict plus a one-sentence reason.
 *
 * It is advice in a column, not a gate — `test_results.verdict` sits beside the two replies
 * for a person to read, and nothing anywhere refuses to apply a draft because this column
 * reads `'worse'`. «Хуже» by the model's own reckoning is sometimes exactly what the owner
 * wanted (a rule that trades a fast answer for a cautious handoff, say); the button that lands
 * a draft is under a human hand, and this is only ever a hint next to it.
 *
 * That also fixes what a failure means: `annotate` never throws, and a caller that gets `null`
 * back leaves `verdict` and `verdictReason` null and moves on. The run itself is the expensive
 * part — up to two model calls a case already, minutes of wall clock — and losing all of that
 * to a hint that did not arrive would be absurd. So this file swallows everything a model call
 * can do wrong (a rejected key, a timeout, a reply that will not parse) and answers `null`
 * rather than let any of it reach the run loop that calls it.
 *
 * `buildVerdictMessages` follows `prompt.ts`'s house style for a reason: it is read by a
 * model, not by the owner, and everything it quotes — the owner's own expectation, the
 * customer's question, both replies — arrives in Russian. It is told outright that it is
 * advising a person who will decide, not deciding itself, the same distinction this file's own
 * comment above draws in code.
 */
import { z } from 'zod';
import type { ChatMessage, ModelClient } from '../ai/openrouter.js';
import { extractJson } from '../ai/turn.js';

/** What one case's comparison needs: the owner's own words on what they expected (if they
 * wrote any), the question the customer actually asked, and both replies — either may be
 * null, the same shape `ReplayResult.reply` already allows for a turn that handed off with
 * nothing to say. */
export interface VerdictInput {
  expectation: string | null;
  question: string;
  before: string | null;
  after: string | null;
}

/** The model's whole answer: one of three words, and why in one sentence. */
export const VERDICT_SCHEMA = z.object({
  verdict: z.enum(['better', 'worse', 'same']),
  reason: z.string(),
});

export type Verdict = z.infer<typeof VERDICT_SCHEMA>;

/** A value the owner may not have filled in, shown as a Russian sentence saying so rather
 * than as an empty line a person would otherwise have to guess the meaning of. */
const orPlaceholder = (value: string | null, whenMissing: string): string => (value === null ? whenMissing : value);

/**
 * One case's whole world for the annotator: what was expected, what was asked, and both
 * answers. A single system message — there is no history here, unlike the coach's own chat,
 * because this is one judgment on one already-finished comparison, not a conversation.
 */
export function buildVerdictMessages(input: VerdictInput): ChatMessage[] {
  const system = [
    'Ты помогаешь владельцу компании сравнить два варианта ответа его продающего агента на ' +
      'один и тот же вопрос клиента: «было» — как агент отвечает сейчас, «стало» — как он ' +
      'ответил бы с предложенным изменением. Скажи, стал ли новый ответ лучше, хуже или не ' +
      'отличается от старого, и объясни почему одним предложением. Ты только советуешь — ' +
      'решение, применять ли изменение, принимает владелец, а не ты.',
    `ОЖИДАНИЕ ВЛАДЕЛЬЦА. ${orPlaceholder(input.expectation, 'владелец не указал, чего ждёт от ответа')}`,
    `ВОПРОС КЛИЕНТА. ${input.question}`,
    `БЫЛО (ответ агента сейчас). ${orPlaceholder(input.before, 'раньше ответа не было')}`,
    `СТАЛО (ответ агента с изменением). ${orPlaceholder(input.after, 'агент не ответил')}`,
    [
      'ФОРМАТ ОТВЕТА. Верни ровно один JSON-объект с двумя ключами: verdict и reason.',
      '- verdict — одно из трёх слов: "better", "worse", "same".',
      '- reason — одно предложение, объясняющее вывод.',
      'Ответ — один JSON-объект и ничего больше: без текста вокруг, без markdown-ограждения ```.',
    ].join('\n'),
  ].join('\n\n---\n\n');

  return [{ role: 'system', content: system }];
}

/** What one call needs to actually reach the model: the client, an already-decrypted key
 * ready to hand to `complete`, and the model id and temperature to call it with. Unlike
 * `runCoach`'s `CoachDeps`, this carries no `Db` and no agent id — the caller (the run route)
 * already has the agent loaded for the run itself, and re-reading it once per case, twenty
 * times a run, would be twenty queries this file has no reason to make on its own. */
export interface AnnotateDeps {
  model: ModelClient;
  key: string;
  modelId: string;
  temperature: string;
}

/**
 * What one call to `annotate` answers: a verdict and its reason when the model's reply parsed,
 * `null` for both when it did not — either way, `cost` is what the call actually spent. Not a
 * plain `null` on a parse failure: the model was still paid the moment `complete` returned, and
 * a caller that only ever sees `null` there has no way to add that cost to a run's own total.
 * `null` only for `annotate` itself — no completion was ever in hand, nothing was spent.
 */
export interface AnnotateResult {
  verdict: 'better' | 'worse' | 'same' | null;
  reason: string | null;
  cost: string;
}

/**
 * One case's verdict, or `null` when the call itself never answered — see the file comment for
 * why a failure here never throws, and `AnnotateResult`'s own comment for why a reply that
 * answered but would not parse is not the same `null`.
 *
 * Exactly one model call, no retry: `runCoach` and `runTurn` retry once because a parse
 * failure is worth a second attempt when the answer is the thing the caller is waiting on.
 * Nothing is waiting on this one — it is a hint that either arrives or does not — so a second
 * attempt would only be a second charge to the owner's balance for a coin flip on the same
 * question.
 */
export async function annotate(deps: AnnotateDeps, input: VerdictInput): Promise<AnnotateResult | null> {
  let completion: { text: string; cost: string };
  try {
    completion = await deps.model.complete({
      key: deps.key,
      model: deps.modelId,
      temperature: deps.temperature,
      messages: buildVerdictMessages(input),
    });
  } catch {
    // No completion in hand — the call itself never landed, so nothing was spent to carry out.
    return null;
  }

  const json = extractJson(completion.text);
  if (json === null) return { verdict: null, reason: null, cost: completion.cost };

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { verdict: null, reason: null, cost: completion.cost };
  }

  const parsed = VERDICT_SCHEMA.safeParse(value);
  if (!parsed.success) return { verdict: null, reason: null, cost: completion.cost };

  return { verdict: parsed.data.verdict, reason: parsed.data.reason, cost: completion.cost };
}
