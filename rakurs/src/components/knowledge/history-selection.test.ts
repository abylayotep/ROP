import { describe, expect, it } from 'vitest';
import { latestConversationIds, historyRunLabel } from './history-selection';

describe('history selection', () => {
  it('selects the latest available chats without mutating the list', () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `chat-${index}`, lastMessageAt: new Date(index * 1_000).toISOString(),
    }));
    expect(latestConversationIds(items, 100)).toHaveLength(100);
    expect(latestConversationIds(items, 200)).toHaveLength(200);
    expect(latestConversationIds(items, 100)[0]).toBe('chat-204');
    expect(items[0]!.id).toBe('chat-0');
  });

  it('does not invent unavailable chats or rank undated ones first', () => {
    expect(latestConversationIds([
      { id: 'unknown', lastMessageAt: null },
      { id: 'known', lastMessageAt: '2026-09-12T01:00:00Z' },
    ], 200)).toEqual(['known', 'unknown']);
    expect(latestConversationIds([], 100)).toEqual([]);
  });

  it('never describes an acknowledged request as imported history', () => {
    expect(historyRunLabel('requesting')).toBe('Отправляем запросы в WhatsApp');
    expect(historyRunLabel('waiting')).toBe('Ждём историю от WhatsApp');
    expect(historyRunLabel('partial')).toBe('История получена частично');
    expect(historyRunLabel('failed')).toBe('Не удалось получить историю');
  });
});
