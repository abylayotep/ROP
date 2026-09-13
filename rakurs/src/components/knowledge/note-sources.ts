import type { KbGenerationSource } from '@/types';

/**
 * The WhatsApp messages behind a generated note, folded for reading.
 *
 * A note is usually backed by the same template reply sent to many customers — «доставка
 * бағасы 1000 тг…» on five different days — and listing it five times buries the one or two
 * messages that actually say something different. Messages are folded by their text: one
 * row per distinct excerpt, newest first, carrying how many times it was sent and a link to
 * the newest message that is still available.
 */

export interface SourceGroup {
  key: string;
  excerpt: string | null;
  /** How many distinct messages carry this text. */
  count: number;
  latestAt: string;
  /** The newest message of the group that can still be opened, if any. */
  open: KbGenerationSource | null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function groupSources(sources: readonly KbGenerationSource[]): SourceGroup[] {
  // The same message can back more than one applied proposal; it is still one message.
  const unique = new Map<string, KbGenerationSource>();
  for (const source of sources) {
    if (!unique.has(source.messageId)) unique.set(source.messageId, source);
  }

  const groups = new Map<string, SourceGroup>();
  for (const source of unique.values()) {
    const excerpt = source.excerpt?.trim() || null;
    // A message without readable text cannot be folded with anything — it keeps its own row.
    const key = excerpt ? normalize(excerpt) : `message:${source.messageId}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        excerpt,
        count: 1,
        latestAt: source.sentAt,
        open: source.available ? source : null,
      });
      continue;
    }
    group.count += 1;
    if (source.sentAt > group.latestAt) group.latestAt = source.sentAt;
    if (source.available && (!group.open || source.sentAt > group.open.sentAt)) group.open = source;
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || b.latestAt.localeCompare(a.latestAt));
}
