import type { KbGenerationPreview, KbGenerationSelection } from '@/types';
import * as api from '@/api';
import { usePollingApi } from '@/hooks/usePollingApi';
import { defaultHistoryDateRange } from './history-selection';

interface PreparationApi {
  list(agentId: string, signal: AbortSignal): Promise<{ id: string }[]>;
  preview(agentId: string, selection: KbGenerationSelection, signal: AbortSignal): Promise<KbGenerationPreview>;
}
const preparationApi: PreparationApi = { list: api.listConversations, preview: api.previewKnowledgeGeneration };

export async function loadRecentHistoryPreparation(agentId: string, signal: AbortSignal, client = preparationApi, now = new Date()) {
  const { from, to } = defaultHistoryDateRange(now);
  const conversations = await client.list(agentId, signal);
  const preview = conversations.length ? await client.preview(agentId, {
    conversationIds: conversations.map(item => item.id),
    from: new Date(`${from}T00:00:00`).toISOString(),
    to: new Date(`${to}T00:00:00`).toISOString(),
  }, signal) : null;
  return { preview, conversations: conversations.length, from, to };
}

const dateLabel = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU');

export function RecentHistoryPreparation({ agentId, busy, onStart }: { agentId: string; busy: boolean; onStart: (preview: KbGenerationPreview) => void }) {
  const source = usePollingApi(signal => loadRecentHistoryPreparation(agentId, signal), [agentId], 60_000);
  const preview = source.data?.preview;
  const range = source.data ?? defaultHistoryDateRange();
  const inclusiveEnd = new Date(`${range.to}T12:00:00`);
  inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
  const excluded = preview ? preview.counts.selectedMessages - preview.counts.eligibleMessages : 0;
  return <section aria-label="Подготовка за последние две недели" style={{ marginTop: 14 }}>
    <div style={{ fontWeight: 650 }}>Все диалоги за последние 2 недели</div>
    <div style={{ fontSize: 13, marginTop: 5 }}>
      {dateLabel(range.from)} — {inclusiveEnd.toLocaleDateString('ru-RU')} включительно.
      {source.data && <> Диалогов: {source.data.conversations}.</>}
    </div>
    {source.loading && <p role="status">Проверяем сохранённые сообщения…</p>}
    {preview && <p style={{ fontSize: 13 }}>
      Сообщений за период: {preview.counts.selectedMessages}. Подходит для обработки: {preview.counts.eligibleMessages}.
      {excluded > 0 && <> Не войдёт в обработку: {excluded}.</>}
    </p>}
    {!source.loading && !source.error && !preview && <p>История ещё не загружена. Подключите WhatsApp и дождитесь сообщений.</p>}
    {preview?.counts.eligibleMessages === 0 && <p>Пока нет подходящих переписок с ответами продавца. Ничего не будет отправлено в AI.</p>}
    {preview?.truncated && <p role="alert">Не весь объём вошёл в обработку. Запуск остановлен, чтобы не потерять часть истории.</p>}
    {source.error !== undefined && <p role="alert" style={{ color: 'var(--danger)' }}>
      Не удалось проверить весь объём: {api.humanError(source.error)} Ничего не отправлено в AI.
    </p>}
    <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
      Подготовим черновики базы знаний и скрипта из ответов продавца. Если данных для одного из них нет, сообщим об этом.
      Ничего не публикуется и не заменяет действующий скрипт автоматически.
    </p>
    <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
      По кнопке обезличенный текст отправится настроенному AI-провайдеру. Обработка расходует его баланс;
      автоматическое скрытие данных не гарантирует полную анонимность.
    </p>
    <button type="button" className="btn" disabled={busy || source.loading || source.error !== undefined || !preview || preview.truncated || preview.counts.eligibleMessages === 0}
      onClick={() => preview && onStart(preview)}>{busy ? 'Запускаем подготовку…' : 'Подготовить базу знаний и скрипт'}</button>
    <details style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>
      <summary>Что войдёт в обработку</summary>
      <p>Берём только сообщения за указанный период, уже сохранённые на сайте. Новые сообщения учитываются при следующем запуске. Объём обновляется раз в минуту.</p>
      {preview && <>
        <p>Пропущено: AI и системных — {preview.counts.skippedAiOrSystem}; вложений без поддерживаемого текста — {preview.counts.skippedUnsupported}; пустых — {preview.counts.skippedEmpty}; чувствительных — {preview.counts.skippedSensitive}; слишком длинных — {preview.counts.skippedOversize}; без ответа продавца — {preview.counts.skippedNoSeller}.</p>
        <p>Модель: {preview.modelId}. Запросов: не больше {preview.maxCalls}. Лимит ответа на запрос: {preview.maxOutputTokens} токенов.</p>
      </>}
      <button type="button" className="btn-sm" disabled={busy || source.refreshing} onClick={source.reload}>Обновить объём</button>
    </details>
  </section>;
}
