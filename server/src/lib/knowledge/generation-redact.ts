const REDACTED = '[redacted]';

const PATTERNS: readonly RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?:\+?\d[\s().-]*){10,15}\d/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
  /\bKZ\d{2}(?:[\s-]*[A-Z0-9]){13,30}\b/gi,
  /(?<![\p{L}\p{N}_])(?:order|заказ)\s*(?:id|номер|№|#)?\s*[:№#-]?\s*[\p{L}\p{N}][\p{L}\p{N}-]{2,}(?![\p{L}\p{N}_])/giu,
  /(?<![\p{L}\p{N}_])(?:address|адрес)\s*:\s*[^\n]+/giu,
  /(?<!\p{L})(?:[Нн]апишите|[Пп]озвоните|[Сс]просите|[Сс]ообщите|[Пп]ередайте)\s+(?:к\s+)?[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu,
  /(?<!\p{L})[Оо]братитесь\s+к\s+[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu,
  /\b(?:[Ww]rite|[Cc]all|[Aa]sk)\s+[A-Z][a-z]{2,}\b/g,
];

/**
 * Removes the deterministic sensitive patterns generation supports in V1.
 *
 * This is deliberately not presented as general anonymization. Selection preview explains
 * the limitation; this function is the enforceable boundary shared by preview and extraction.
 */
export function redactGenerationText(text: string): string | null {
  let redacted = text.replace(/\r\n?/g, '\n');
  for (const pattern of PATTERNS) redacted = redacted.replace(pattern, REDACTED);
  redacted = redacted.trim();
  if (redacted === '') return null;

  const usable = redacted
    .replaceAll(REDACTED, '')
    .replace(/[\s.,:;!?()[\]{}'"`~@#$%^&*+=_|/\\-]+/g, '');
  return usable === '' ? null : redacted;
}
