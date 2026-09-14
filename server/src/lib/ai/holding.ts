/**
 * The one line a customer gets when the agent cannot give them a real answer.
 *
 * Several turn endings used to send nothing: a reply withheld for a number no source contains,
 * a model that answered twice in a shape nobody can read, a model call that failed outright —
 * OpenRouter out of money included — and a customer who sent only a photo or a voice note the
 * agent cannot see. Each hands the thread to a person, but the customer only saw silence and
 * waited on it. This line tells them somebody is on it, in their own language, and nothing more:
 * it carries no fact, so it can never be the wrong answer.
 */
import { languageName, unseenAttachment, type PromptMessage } from './prompt.js';

/** Customer-facing, so in the customers' languages rather than the repository's. */
export const HOLDING_REPLIES = {
  ru: 'Секунду, уточню у коллеги и сразу вернусь с ответом.',
  kk: 'Бір сәт, әріптесімнен нақтылап, қазір жазамын.',
} as const;

export type HoldingLanguage = keyof typeof HOLDING_REPLIES;

/** Letters Kazakh has and Russian does not. One is enough to tell the two apart. */
const KAZAKH_LETTERS = /[әғқңөұүһі]/i;
const KAZAKH_NAME = /^(қазақ|казах|kazakh|kazak|qazaq)/i;

/**
 * The language the prompt's rule 3 would have the agent answer in, decided without a model.
 *
 * An owner who chose a language gets it when it is Kazakh and Russian otherwise — the two
 * lines above are all there is. On `auto` the customer's newest message with any text decides,
 * as it does for the model; a thread with no customer text at all is answered in Russian.
 */
export function holdingLanguage(replyLanguage: string, history: readonly PromptMessage[]): HoldingLanguage {
  const chosen = languageName(replyLanguage);
  if (chosen !== null) return KAZAKH_NAME.test(chosen) ? 'kk' : 'ru';
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const body = (message.body ?? '').trim();
    if (message.author !== 'client' || body === '') continue;
    return KAZAKH_LETTERS.test(body) ? 'kk' : 'ru';
  }
  return 'ru';
}

export function holdingReply(replyLanguage: string, history: readonly PromptMessage[]): string {
  return HOLDING_REPLIES[holdingLanguage(replyLanguage, history)];
}

const HOLDING_TEXTS: ReadonlySet<string> = new Set(Object.values(HOLDING_REPLIES));

/**
 * Whether the customer already has a holding line nobody has spoken past: the newest outbound
 * message is one, and the customer has not written since. A redelivered event or a retried turn
 * must not tell them «секунду» twice.
 */
export function alreadyHolding(history: readonly PromptMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.author === 'client') return false;
    if (message.author === 'system') continue;
    return HOLDING_TEXTS.has((message.body ?? '').trim());
  }
  return false;
}

/**
 * What the customer sent since our side last spoke, when every piece of it is an attachment
 * with no caption and no transcript — the turn the model would answer blind. Null otherwise,
 * including when there is nothing new from the customer at all.
 */
export function unseenSinceLastReply(history: readonly PromptMessage[]): PromptMessage[] | null {
  const since: PromptMessage[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.author !== 'client') break;
    since.unshift(message);
  }
  return since.length > 0 && since.every(unseenAttachment) ? since : null;
}
