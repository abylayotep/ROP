/**
 * Two single-call model helpers the draft autopilot uses on one topic's body: `cleanTopic`
 * strips chat dialogue that generation copied into a note, `rewriteTopic` reworks a topic that
 * made replayed answers worse.
 *
 * Their output reaches customers without a human reading it, so every reply passes the same
 * guards before the caller writes anything, the most important being that the new body carries
 * no number the old one did not — an invented price is the one mistake an owner cannot afford.
 * No retry: a second attempt is a second charge for the same question, and the autopilot treats
 * a refusal as "leave this topic as it was".
 */
import { z } from 'zod';
import type { ChatMessage, ModelClient } from '../ai/openrouter.js';
import { extractJson } from '../ai/turn.js';
import { BODY_MAX } from '../knowledge/note.js';
import type { FailingCase } from './autopilot-types.js';

export interface TopicFixDeps {
  model: ModelClient;
  key: string;
  modelId: string;
  temperature: string;
}

export interface TopicFixResult {
  body: string;
  reason: string;
  cost: string;
}

export type TopicFixCode = 'malformed_output' | 'invented_number' | 'too_long' | 'empty';

/** Carries the call's cost even on refusal: the owner paid for the reply whether or not it was
 * usable, and the autopilot adds it to its running total. */
export class TopicFixError extends Error {
  constructor(
    readonly code: TopicFixCode,
    readonly cost: string,
  ) {
    super(`topic fix refused: ${code}`);
    this.name = 'TopicFixError';
  }
}

/** Generation limit: a topic longer than this would not come back whole from one call. */
export const TOPIC_FIX_INPUT_MAX = 8_000;

const OUTPUT_SCHEMA = z.object({ body: z.string(), reason: z.string() });

/** Digit runs in `after` that do not occur in `before`. Spaces inside a number are dropped
 * first so "9 990" and "9990" count as the same price. */
export function inventedNumbers(before: string, after: string): string[] {
  const runs = (text: string): string[] => text.replace(/(\d)[\s ](?=\d)/g, '$1').match(/\d+/g) ?? [];
  const known = new Set(runs(before));
  const invented: string[] = [];
  for (const run of runs(after)) {
    if (!known.has(run) && !invented.includes(run)) invented.push(run);
  }
  return invented;
}

const KEEP_RULES = [
  'Keep: every price, amount, phone number, address, bank, schedule, deadline and condition exactly as written. Keep existing "##" headings. "## Готовые фразы" may keep reusable replies in any language, including Kazakh.',
  'Never add information that is not already in the topic. Write in the language(s) the topic already uses.',
].join('\n');

const CLEAN_SYSTEM = [
  "You maintain one topic of a sales agent's knowledge base. The topic was generated from real customer chats and may contain dialogue instead of knowledge.",
  'Remove: verbatim customer or manager chat lines, questions addressed to a customer, greetings, emojis, and anything that is conversation rather than a fact about the business. Remove them from "## Факты" and from free text.',
  KEEP_RULES,
  'Answer with one JSON object: {"body": "<full new topic markdown>", "reason": "<one short Russian sentence on what you removed, empty if nothing>"}.',
].join('\n');

const REWRITE_SYSTEM = [
  "You maintain one topic of a sales agent's knowledge base.",
  'The agent answered the cases below worse with this topic than without it. Rewrite the topic so an agent reading it answers these cases well: reorganise, clarify, and drop the lines that caused the bad answer.',
  KEEP_RULES,
  'Answer with one JSON object: {"body": "<full new topic markdown>", "reason": "<one short Russian sentence on what you changed>"}.',
].join('\n');

function topicText(input: { title: string; body: string }): string {
  return `Topic title: ${input.title}\n\nTopic body:\n${input.body}`;
}

function caseText(c: FailingCase, index: number): string {
  return [
    `Case ${index + 1}: ${c.title}`,
    ...c.messages.map((m) => `Customer: ${m}`),
    `Before: ${c.before ?? '(no answer)'}`,
    `After (worse): ${c.after ?? '(no answer)'}`,
    `Judge: ${c.reason ?? '(no reason)'}`,
  ].join('\n');
}

async function fixTopic(
  deps: TopicFixDeps,
  original: string,
  messages: ChatMessage[],
): Promise<TopicFixResult> {
  if (original.length > TOPIC_FIX_INPUT_MAX) throw new TopicFixError('too_long', '0');

  const completion = await deps.model.complete({
    key: deps.key,
    model: deps.modelId,
    temperature: deps.temperature,
    messages,
  });
  const cost = completion.cost;

  const json = extractJson(completion.text);
  if (json === null) throw new TopicFixError('malformed_output', cost);
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new TopicFixError('malformed_output', cost);
  }
  const parsed = OUTPUT_SCHEMA.safeParse(value);
  if (!parsed.success) throw new TopicFixError('malformed_output', cost);

  const { body, reason } = parsed.data;
  if (body.trim() === '') throw new TopicFixError('empty', cost);
  if (body.length > BODY_MAX) throw new TopicFixError('too_long', cost);
  if (inventedNumbers(original, body).length > 0) throw new TopicFixError('invented_number', cost);

  if (body.trim() === original.trim()) return { body: original, reason: '', cost };
  return { body, reason: reason.trim(), cost };
}

export async function cleanTopic(
  deps: TopicFixDeps,
  input: { title: string; body: string },
): Promise<TopicFixResult> {
  return fixTopic(deps, input.body, [
    { role: 'system', content: CLEAN_SYSTEM },
    { role: 'user', content: topicText(input) },
  ]);
}

export async function rewriteTopic(
  deps: TopicFixDeps,
  input: { title: string; body: string; cases: FailingCase[] },
): Promise<TopicFixResult> {
  const cases = input.cases.map(caseText).join('\n\n');
  return fixTopic(deps, input.body, [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: `${topicText(input)}\n\nCases:\n\n${cases}` },
  ]);
}
