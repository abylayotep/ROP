import type { ConversationSummary } from '@/types';

const localDateInput = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function defaultHistoryDateRange(now = new Date()): { from: string; to: string } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 13);
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  to.setDate(to.getDate() + 1);
  return { from: localDateInput(from), to: localDateInput(to) };
}

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
