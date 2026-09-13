import { describe, expect, it } from 'vitest';
import { groupSources } from './note-sources';

const source = (messageId: string, sentAt: string, excerpt: string | null, available = true) => ({
  conversationId: `c-${messageId}`,
  messageId,
  sentAt,
  excerpt,
  available,
});

describe('groupSources', () => {
  it('folds the same template reply into one row with a count', () => {
    const groups = groupSources([
      source('a', '2026-09-08T10:00:00Z', 'Доставка 1000 тг'),
      source('b', '2026-09-11T10:00:00Z', 'доставка  1000 тг '),
      source('c', '2026-09-09T10:00:00Z', 'Самовывоз или курьер'),
    ]);
    expect(groups.map((g) => [g.excerpt, g.count])).toEqual([
      ['Доставка 1000 тг', 2],
      ['Самовывоз или курьер', 1],
    ]);
    expect(groups[0]!.latestAt).toBe('2026-09-11T10:00:00Z');
    expect(groups[0]!.open?.messageId).toBe('b');
  });

  it('counts a message backing two proposals once', () => {
    const groups = groupSources([source('a', '2026-09-08T10:00:00Z', 'x'), source('a', '2026-09-08T10:00:00Z', 'x')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(1);
  });

  it('links only to a message that is still available', () => {
    const groups = groupSources([
      source('a', '2026-09-12T10:00:00Z', 'x', false),
      source('b', '2026-09-08T10:00:00Z', 'x'),
    ]);
    expect(groups[0]!.open?.messageId).toBe('b');
    expect(groupSources([source('a', '2026-09-12T10:00:00Z', 'x', false)])[0]!.open).toBeNull();
  });

  it('keeps messages without text apart', () => {
    expect(groupSources([source('a', '2026-09-08T10:00:00Z', null), source('b', '2026-09-08T10:00:00Z', '')])).toHaveLength(2);
  });
});
