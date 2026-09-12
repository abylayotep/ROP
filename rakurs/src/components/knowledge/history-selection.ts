import type { ConversationSummary } from '@/types';

export function latestConversationIds(
  conversations: Pick<ConversationSummary, 'id' | 'lastMessageAt'>[], limit: 100 | 200,
): string[] {
  const timestamp = (value: string | null) => value ? Date.parse(value) || 0 : 0;
  return [...conversations].sort((a, b) =>
    timestamp(b.lastMessageAt) - timestamp(a.lastMessageAt) || a.id.localeCompare(b.id),
  ).slice(0, limit).map(({ id }) => id);
}

export function historyRunLabel(status: 'requesting' | 'waiting' | 'completed' | 'partial' | 'failed'): string {
  return {
    requesting: 'Отправляем запросы в WhatsApp',
    waiting: 'Ждём историю от WhatsApp',
    completed: 'Ответы с историей получены',
    partial: 'История получена частично',
    failed: 'Не удалось получить историю',
  }[status];
}
