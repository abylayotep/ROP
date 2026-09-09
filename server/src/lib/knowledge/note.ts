import { splitLongText } from './split.js';

/** The five values a record's type had. Frontmatter carries it now; chunks mirror it. */
export type KbNoteKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';
const KINDS: readonly string[] = ['product', 'qa', 'procedure', 'contact', 'other'];

/** A body long enough to hold a price list, short enough that one save is one request. */
export const BODY_MAX = 200_000;

export interface NoteSection {
  heading: string;
  content: string;
}

export interface ParsedNote {
  kind: KbNoteKind;
  tags: string[];
  sections: NoteSection[];
}

// Kept as a second copy of split.ts's `normalise` rather than imported: that function is
// private there, and exporting it just for this would widen split.ts's surface for the sake
// of four lines that never change independently of this comment.
const normalise = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * The two frontmatter keys we read, in the one shape we write.
 *
 * Not a YAML parser: a dependency that reads arbitrary YAML would read anchors and tags we
 * have no use for, and the failure mode of this function is «leave the block as text», which
 * shows the owner their own dashes rather than swallowing their first paragraph.
 */
function readFrontmatter(body: string): { kind: KbNoteKind; tags: string[]; rest: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (!match) return null;

  let kind: KbNoteKind = 'other';
  const tags: string[] = [];
  for (const line of match[1]!.split('\n')) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (!pair) return null;
    const [, key, value] = pair;
    if (key === 'kind' && KINDS.includes(value!)) kind = value as KbNoteKind;
    else if (key === 'tags') {
      const list = value!.replace(/^\[|\]$/g, '');
      tags.push(...list.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''));
    }
  }
  return { kind, tags, rest: body.slice(match[0].length) };
}

/**
 * A note becomes the sections the agent retrieves.
 *
 * Flat, not nested: a `###` under a `##` is its own section, because the agent quotes what it
 * is handed and a nested section would carry its parent's text into every answer.
 */
export function parseNote(body: string): ParsedNote {
  const text = normalise(body);
  const front = readFrontmatter(text);
  const lines = (front?.rest ?? text).split('\n');

  const sections: NoteSection[] = [];
  let heading = '';
  let buffer: string[] = [];
  let fenced = false;

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content === '') return;
    // One section per piece when a section outgrows its column. The heading repeats: the
    // pieces are numbered in the chunk title, which is where a reader sees them.
    for (const piece of splitLongText(content)) sections.push({ heading, content: piece });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const found = fenced ? null : /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (found) {
      flush();
      heading = found[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { kind: front?.kind ?? 'other', tags: front?.tags ?? [], sections };
}
