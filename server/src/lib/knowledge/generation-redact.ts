const REDACTED = '[redacted]';

const PHONE = /(?:\+?\d[\s().-]*){10,15}\d/g;
const LABELLED_ADDRESS = /(?<![\p{L}\p{N}_])(?:address|адрес)\s*:\s*[^\n]+/giu;
const ADDRESS_LABEL = /^(?:address|адрес)\s*:\s*/iu;

const PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  PHONE,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\bKZ\d{2}(?:[\s-]*[A-Z0-9]){13,30}\b/gi,
  /(?<![\p{L}\p{N}_])(?:order|заказ)\s*(?:id|номер|№|#)?\s*[:№#-]?\s*[\p{L}\p{N}][\p{L}\p{N}-]{2,}(?![\p{L}\p{N}_])/giu,
  LABELLED_ADDRESS,
];

/** Personal names: redacted before allowed contacts are protected, so no allowance can keep one. */
const NAME_PATTERNS: readonly RegExp[] = [
  /(?<!\p{L})(?:[Нн]апишите|[Пп]озвоните|[Сс]просите|[Сс]ообщите|[Пп]ередайте)\s+(?:к\s+)?[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu,
  /(?<!\p{L})[Оо]братитесь\s+к\s+[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu,
  /\b(?:[Ww]rite|[Cc]all|[Aa]sk)\s+[A-Z][a-z]{2,}\b/g,
];

/** A street address written out in a sentence; the final content policy rejects it. Word-anchored, so long text stays linear. */
export const NATURAL_ADDRESS = /(?:(?:улиц(?:а|е|ы)|ул\.)\s+[\p{L}.-]+[^\n]{0,48}дом\s*\d+|(?<![\p{L}.-])[\p{L}.-]+\s+көшесі\s*\d+\s*үй)/iu;

const URL = /https?:\/\/[^\s<>«»"']+/giu;

const globalOf = (pattern: RegExp): RegExp =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

/** Private-use characters: no redaction pattern matches them, and chat text never holds them. */
const MARK = String.fromCharCode(0xf8ff);
const placeholder = (index: number): string => `${MARK}${String.fromCharCode(0xe000 + index)}${MARK}`;
const PLACEHOLDER = /\uF8FF[\uE000-\uF8FE]\uF8FF/gu;

/** A match that is only allowed contacts — «Адрес: <allowed>» — is left alone; anything more is redacted. */
const onlyAllowed = (match: string): boolean =>
  match.replace(PLACEHOLDER, '') !== match &&
  match.replace(ADDRESS_LABEL, '').replace(PLACEHOLDER, '').replace(/[\s.,;:()-]+/g, '') === '';

/** Swaps every allowed substring for a placeholder, longest first, so patterns cannot touch it. */
const protect = (text: string, allowed: Iterable<string>): { text: string; restore: (value: string) => string } => {
  const spans = [...new Set(allowed)].filter((span) => span.trim() !== '').sort((a, b) => b.length - a.length);
  let protectedText = text;
  const used: [string, string][] = [];
  for (const span of spans) {
    if (!protectedText.includes(span)) continue;
    const token = placeholder(used.length);
    protectedText = protectedText.replaceAll(span, token);
    used.push([token, span]);
  }
  return {
    text: protectedText,
    restore: (value) => used.reduce((result, [token, span]) => result.replaceAll(token, span), value),
  };
};

export interface RedactionOptions {
  /**
   * Exact business contacts left intact (see `sharedBusinessContacts`). Only spans produced by
   * `contactSpans` belong here: names, emails, cards and order numbers are never allowed.
   */
  allowed?: Iterable<string>;
}

/**
 * Removes the deterministic sensitive patterns generation supports in V1.
 *
 * This is deliberately not presented as general anonymization. Selection preview explains
 * the limitation; this function is the enforceable boundary shared by preview and extraction.
 */
export function redactGenerationText(text: string, options: RedactionOptions = {}): string | null {
  let normalized = text.replace(/\r\n?/g, '\n');
  for (const pattern of NAME_PATTERNS) normalized = normalized.replace(pattern, REDACTED);
  const guard = protect(normalized, options.allowed ?? []);
  let redacted = guard.text;
  for (const pattern of PATTERNS) {
    redacted = redacted.replace(pattern, (match) => (onlyAllowed(match) ? match : REDACTED));
  }
  redacted = guard.restore(redacted).trim();
  if (redacted === '') return null;

  const usable = redacted
    .replaceAll(REDACTED, '')
    .replace(/[\s.,:;!?()[\]{}'"`~@#$%^&*+=_|/\\-]+/g, '');
  return usable === '' ? null : redacted;
}

/**
 * The contacts in `text` a business could be sending to every customer: a link redaction would
 * cut (a 2GIS or map link with a long id), a phone number, an «Адрес: …» line, a written-out
 * street address. Exact substrings, so they can be allowed verbatim and nothing near them.
 */
export function contactSpans(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const spans: string[] = [];
  let rest = normalized;
  for (const match of normalized.matchAll(URL)) {
    const url = match[0].replace(/[.,;:!?)]+$/, '');
    if (redactGenerationText(url) === url && !NATURAL_ADDRESS.test(url)) continue;
    spans.push(url);
    rest = rest.replaceAll(url, ' ');
  }
  for (const pattern of [PHONE, LABELLED_ADDRESS, globalOf(NATURAL_ADDRESS)]) {
    for (const match of rest.matchAll(pattern)) {
      // The label is not part of the contact: «Адрес: X» and «Наш адрес: X» share X.
      const span = match[0].replace(ADDRESS_LABEL, '').trim().replace(/[.,;:]+$/u, '');
      if (span !== '') spans.push(span);
    }
  }
  return [...new Set(spans)];
}

/**
 * Contacts the seller sent in at least two different conversations. A phone, address or map link
 * the seller repeats to many customers is the business's own, not a customer's, so generation
 * keeps it; one seen in a single conversation stays redacted. Customer messages never count.
 */
export function sharedBusinessContacts(
  messages: readonly { conversationId: string; author: string; body: string }[],
): Set<string> {
  const conversationsBySpan = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.author === 'client') continue;
    for (const span of contactSpans(message.body)) {
      const seen = conversationsBySpan.get(span) ?? new Set<string>();
      seen.add(message.conversationId);
      conversationsBySpan.set(span, seen);
    }
  }
  return new Set([...conversationsBySpan].filter(([, seen]) => seen.size >= 2).map(([span]) => span));
}
