/**
 * Five to ten customer questions aimed at what a draft changes — the model's opinion of what
 * the case set is missing, for an owner deciding what to add to it before running one.
 *
 * Nothing here is saved. `api/test-cases.ts`'s own `suggest-cases` route hands the model's list
 * straight back to the screen; a case set that grows by itself is a set nobody trusts, so the
 * owner is the one who decides what actually joins it — the same reason `annotate.ts`'s verdict
 * gates nothing either.
 *
 * Unlike `annotate`, a failure here is not swallowed: nothing else is running behind this call
 * that a lost hint would leave unaffected — the whole point of the request was this list, so a
 * bad reply is a `SuggestParseError` the route turns into a proper refusal instead of a silent
 * empty screen.
 */
import { z } from 'zod';
import type { ChatMessage, ModelClient } from '../ai/openrouter.js';
import { extractJson } from '../ai/turn.js';
import type { DraftOp } from './ops.js';

export interface SuggestedCase {
  title: string;
  messages: string[];
}

const SUGGEST_SCHEMA = z.object({
  cases: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        messages: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .min(1),
});

/** One op, read out loud in Russian for the prompt — the same information `titleFor`
 * (api/drafts.ts) turns into a list entry's title, but describing the whole change rather than
 * just naming the row it touches. */
function describeOp(op: DraftOp): string {
  switch (op.op) {
    case 'note_create':
      return `добавляет в базу знаний заметку «${op.path}»: ${op.body}`;
    case 'note_update':
      return `меняет текст заметки в базе знаний на: ${op.body}`;
    case 'rule_create':
      return `добавляет правило (${op.category}): ${op.text}`;
    case 'rule_update':
      return op.text !== undefined
        ? `меняет текст правила на: ${op.text}`
        : `${op.enabled ? 'включает' : 'выключает'} правило`;
    default: {
      const exhaustive: never = op;
      throw new Error(`unknown draft op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildSuggestMessages(ops: readonly DraftOp[]): ChatMessage[] {
  const changes = ops.map((op, i) => `${i + 1}. ${describeOp(op)}`).join('\n');
  const system = [
    'Ты помогаешь владельцу компании подобрать вопросы клиентов, на которых стоит проверить ' +
      'предложенное изменение продающего агента в WhatsApp, прежде чем оно вступит в силу.',
    `ЧЕРНОВИК. Предложенное изменение:\n${changes}`,
    'Придумай от пяти до десяти разных случаев — вопросов или коротких реплик клиента, ' +
      'на которых разница между старым и новым поведением агента будет заметна.',
    [
      'ФОРМАТ ОТВЕТА. Верни ровно один JSON-объект с одним ключом: cases.',
      '- cases — список случаев: {"title": "короткое название", "messages": ["реплика клиента"]}.',
      '- messages — только слова клиента, без ответов агента.',
      'Ответ — один JSON-объект и ничего больше: без текста вокруг, без markdown-ограждения ```.',
    ].join('\n'),
  ].join('\n\n---\n\n');
  return [{ role: 'system', content: system }];
}

export interface SuggestDeps {
  model: ModelClient;
  key: string;
  modelId: string;
  temperature: string;
}

/** The model answered, but not with anything `suggestCases` can hand back — no JSON object, a
 * broken one, or one that does not match `SUGGEST_SCHEMA`. The route turns this into a Russian
 * 502; kept in English here, the same choice `turn-cap.ts`'s own defensive throw makes, since
 * nothing reads this message except that one catch. */
export class SuggestParseError extends Error {}

/** One call, no retry — the same reasoning `annotate`'s own comment gives for itself: a second
 * attempt would only be a second charge to the owner's balance on the same question, and this
 * one is a suggestion, not an answer anything downstream is blocked on. */
export async function suggestCases(deps: SuggestDeps, ops: readonly DraftOp[]): Promise<SuggestedCase[]> {
  const completion = await deps.model.complete({
    key: deps.key,
    model: deps.modelId,
    temperature: deps.temperature,
    messages: buildSuggestMessages(ops),
  });

  const json = extractJson(completion.text);
  if (json === null) throw new SuggestParseError('no JSON object in reply');

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new SuggestParseError('malformed JSON');
  }

  const parsed = SUGGEST_SCHEMA.safeParse(value);
  if (!parsed.success) throw new SuggestParseError('reply did not match the schema');

  return parsed.data.cases;
}
