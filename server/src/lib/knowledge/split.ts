/** The knowledge columns' limits, kept beside the code that has to respect them. */
export const TITLE_MAX = 200;
export const CONTENT_MAX = 8000;

export interface SplitPart {
  title: string;
  content: string;
}

/**
 * A title too long for its column, cut to fit and marked as cut.
 *
 * Whole code points, never `slice`: a UTF-16 index can land between the two halves of a
 * surrogate pair, and an emoji in a pasted heading would then reach the database as a lone
 * surrogate — which is not valid UTF-8, so it arrives as `�` if it arrives at all. The
 * budget is still counted in UTF-16 units, because that is what the column and the route's
 * `max()` both measure.
 */
function clampTitle(line: string, max: number = TITLE_MAX): string {
  if (line.length <= max) return line;

  let kept = '';
  for (const char of line) {
    if (kept.length + char.length > max - 1) break;
    kept += char;
  }
  return `${kept}…`;
}

/**
 * Where to cut a window that is too long, in order of how little the cut costs the reader.
 *
 * A paragraph break keeps whole paragraphs, a line break keeps whole lines, a space keeps
 * whole words — and a hard cut at the limit would land in the middle of a word or, worse, in
 * the middle of a price. The first candidate past the halfway mark wins: one in the first few
 * characters would leave a piece too small to be an answer, and would barely advance us
 * through the body.
 *
 * They are tried in turn rather than compared with `Math.max`, which is what this did before:
 * the last `\n` is by definition never earlier than the last `\n\n`, so a maximum can never
 * choose the paragraph break, and the term for it was dead code.
 */
function cutAt(window: string): number {
  const candidates = [
    window.lastIndexOf('\n\n'),
    window.lastIndexOf('\n'),
    window.lastIndexOf(' '),
  ];
  return candidates.find((at) => at > CONTENT_MAX / 2) ?? CONTENT_MAX;
}

/** Cuts a body too long for its column into pieces, each one cut where it costs least. */
function cut(content: string): string[] {
  if (content.length <= CONTENT_MAX) return [content];

  const pieces: string[] = [];
  let rest = content;
  while (rest.length > CONTENT_MAX) {
    const end = cutAt(rest.slice(0, CONTENT_MAX));
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/** One part per piece, numbered when there is more than one so a hit still reads sensibly. */
function toParts(title: string, content: string): SplitPart[] {
  const pieces = cut(content);
  if (pieces.length === 1) return [{ title: clampTitle(title), content: pieces[0]! }];
  return pieces.map((piece, index) => {
    // The number is appended after the clamp, not clamped with it: a title that already
    // fills the column would otherwise have its own `(2)` truncated away, and every piece of
    // a long body would come back under one identical title — which is the opposite of the
    // promise that a continuation says what it continues.
    const suffix = ` (${index + 1})`;
    return { title: `${clampTitle(title, TITLE_MAX - suffix.length)}${suffix}`, content: piece };
  });
}

/**
 * What every splitter sees: one kind of line ending, and no control characters.
 *
 * A price list copied out of a PDF or a spreadsheet carries NUL bytes and other C0 controls,
 * and Postgres will not hold a NUL in a text column at all — so a paste that looked ordinary
 * to the owner used to reach the insert and come back as «Внутренняя ошибка сервера», which
 * tells them nothing they could act on. They are dropped rather than refused: a control
 * character is an artefact of where the text was copied from, not something the owner typed
 * and not something they can see to remove. `\n` and `\t` are kept — those are layout.
 *
 * Dropped rather than replaced with a space, because the common case is text decoded as the
 * wrong width, where every second byte is a NUL: replacing would turn «Дверь» into «Д в е р ь».
 */
const normalise = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * A pasted block becomes items: blank lines separate them, the first line names each one.
 *
 * The rule is simple enough that an owner can predict it from one look at the result, which
 * matters more here than any cleverness — they are going to paste, look, and paste again.
 */
export function splitBlocks(text: string): SplitPart[] {
  return normalise(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .flatMap((block) => {
      const [first = '', ...rest] = block.split('\n');
      const body = rest.join('\n').trim();
      // A single line is its own title and its own content: a one-line fact is still a
      // fact, and refusing it would make an owner pad their text to satisfy us.
      return toParts(first.trim(), body === '' ? first.trim() : body);
    });
}

/**
 * A page's text becomes items: a markdown heading starts one, the text under it is the body.
 *
 * A heading with nothing under it is dropped — that is a navigation label that survived the
 * strip, not a fact. A page with no headings is one item, because the alternative is
 * throwing away everything the owner asked us to read.
 */
export function splitByHeadings(text: string): SplitPart[] {
  const lines = normalise(text).split('\n');
  const parts: SplitPart[] = [];

  let title: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content === '') return;
    parts.push(...toParts(title ?? content.split('\n')[0]!.trim(), content));
  };

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return parts;
}
