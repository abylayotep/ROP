/**
 * A markdown renderer written here rather than pulled in.
 *
 * A note's body can come from a page someone imported from a stranger's site, and the one
 * thing this renderer must never do is pass that text through as HTML: `renderMarkdown`
 * never builds a string of markup, only a tree of typed nodes, so there is no `innerHTML`
 * anywhere between a note and the screen for a `<script>` or an `onerror=` to survive in.
 *
 * It understands headings, bold, italic, lists, wiki links (`[[Target]]` /
 * `[[Target|label]]`), inline code, fenced code and blockquotes — exactly what the vault's
 * own notes use — and nothing past that: no raw HTML, no tables, no images. A syntax this
 * does not recognise is left as plain text rather than guessed at.
 */

export interface MarkdownText {
  kind: 'text';
  text: string;
}

export interface MarkdownBold {
  kind: 'bold';
  text: string;
}

export interface MarkdownItalic {
  kind: 'italic';
  text: string;
}

export interface MarkdownInlineCode {
  kind: 'inline-code';
  text: string;
}

/** `noteId` is resolved by the caller elsewhere; here a link only knows the title it named. */
export interface MarkdownLink {
  kind: 'link';
  target: string;
  label: string;
  /** True when no note in the vault carries `target` as its title. */
  broken: boolean;
}

/** The inline run inside a paragraph, a heading, a list item or a blockquote line. */
export type InlineNode = MarkdownText | MarkdownBold | MarkdownItalic | MarkdownInlineCode | MarkdownLink;

export interface MarkdownHeading {
  kind: 'heading';
  /** 1 for `#`, up to 6 for `######`. */
  level: number;
  children: InlineNode[];
}

export interface MarkdownListItem {
  kind: 'list-item';
  ordered: boolean;
  children: InlineNode[];
}

export interface MarkdownBlockquote {
  kind: 'blockquote';
  children: InlineNode[];
}

/** A fenced block, kept verbatim: its lines are never scanned for headings or links. */
export interface MarkdownCode {
  kind: 'code';
  text: string;
}

/** A blank line between paragraphs. The renderer groups runs around it into `<p>`s. */
export interface MarkdownBreak {
  kind: 'break';
}

export type MarkdownNode =
  | InlineNode
  | MarkdownHeading
  | MarkdownListItem
  | MarkdownBlockquote
  | MarkdownCode
  | MarkdownBreak;

/**
 * One line of inline markdown, scanned left to right for the spans this renderer knows.
 *
 * Bold is tried before italic at every position so `**x**` is not read as `*` followed by
 * `*x*` followed by `*` — the alternation below lists the two-character delimiters first,
 * and a regex's alternatives are tried in order at a given starting index.
 */
const INLINE =
  /`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;

function parseInline(text: string, titles: Set<string>): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ kind: 'text', text: text.slice(last, index) });

    const [, code, linkTarget, linkLabel, boldStar, boldUnderscore, italicStar, italicUnderscore] = match;
    if (code !== undefined) {
      nodes.push({ kind: 'inline-code', text: code });
    } else if (linkTarget !== undefined) {
      const target = linkTarget.trim();
      nodes.push({ kind: 'link', target, label: (linkLabel ?? linkTarget).trim(), broken: !titles.has(target) });
    } else if (boldStar !== undefined || boldUnderscore !== undefined) {
      nodes.push({ kind: 'bold', text: (boldStar ?? boldUnderscore)! });
    } else if (italicStar !== undefined || italicUnderscore !== undefined) {
      nodes.push({ kind: 'italic', text: (italicStar ?? italicUnderscore)! });
    }

    last = index + match[0].length;
  }
  if (last < text.length) nodes.push({ kind: 'text', text: text.slice(last) });

  return nodes;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;

export function renderMarkdown(body: string, titles: Set<string>): MarkdownNode[] {
  const lines = body.split('\n');
  const nodes: MarkdownNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().startsWith('```')) {
      let close = i + 1;
      while (close < lines.length && !lines[close]!.trim().startsWith('```')) close++;
      // Verbatim: a fenced block is the one place a `#` or a `[[` is just a character, not
      // syntax — the third test above pins exactly this (a fenced `# heading` stays text).
      nodes.push({ kind: 'code', text: lines.slice(i + 1, close).join('\n') });
      i = close + 1;
      continue;
    }

    if (line.trim() === '') {
      // Collapsed rather than one `break` per blank line: two runs separated by three blank
      // lines are one paragraph gap, not three, and the renderer only needs to know there
      // was a gap at all.
      if (nodes.length > 0 && nodes[nodes.length - 1]!.kind !== 'break') nodes.push({ kind: 'break' });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({ kind: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!, titles) });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      nodes.push({ kind: 'blockquote', children: parseInline(quote[1]!, titles) });
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      nodes.push({ kind: 'list-item', ordered: false, children: parseInline(bullet[1]!, titles) });
      i++;
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      nodes.push({ kind: 'list-item', ordered: true, children: parseInline(numbered[1]!, titles) });
      i++;
      continue;
    }

    // A plain paragraph line: its inline runs join the flat stream directly rather than
    // sitting inside a `paragraph` wrapper node — the only grouping this module does is by
    // block type (heading, list item, quote, code); the caller regroups runs into `<p>`s.
    nodes.push(...parseInline(line, titles));
    i++;
  }

  while (nodes.length > 0 && nodes[0]!.kind === 'break') nodes.shift();
  while (nodes.length > 0 && nodes[nodes.length - 1]!.kind === 'break') nodes.pop();

  return nodes;
}
