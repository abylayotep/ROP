import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { usePollingApi } from '@/hooks/usePollingApi';
import { historyRunLabel } from './history-selection';

/** Requests available history; an acknowledgement never means the messages arrived. */
export function HistoryImportPanel({ agentId, readOnly = false }: {
  agentId: string; readOnly?: boolean;
}) {
  const status = usePollingApi((signal) => api.getWhatsappHistory(agentId, signal), [agentId]);
  const archive = usePollingApi((signal) => api.getWhatsappHistoryArchive(agentId, signal), [agentId]);
  const [limit, setLimit] = useState<100 | 200>(100);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setError(null);
    setSubmitting(false);
    return () => controller.current?.abort();
  }, [agentId]);
  const run = status.data?.run;
  const active = run?.status === 'requesting' || run?.status === 'waiting';
  const connected = (status.data?.connectedNumbers ?? 0) > 0;

  async function start() {
    if (submitting || active || readOnly) return;
    const request = new AbortController();
    controller.current = request;
    setSubmitting(true);
    setError(null);
    try {
      await api.startWhatsappHistory(agentId, limit, request.signal);
      if (!request.signal.aborted) status.reload();
    } catch (caught) {
      if (!request.signal.aborted) setError(api.humanError(caught));
    } finally {
      if (!request.signal.aborted) setSubmitting(false);
    }
  }

  async function replay(packetId: string) {
    if (readOnly || replaying) return;
    setReplaying(packetId);
    setError(null);
    try {
      await api.replayWhatsappHistoryArchive(agentId, packetId);
      archive.reload();
    } catch (caught) {
      setError(api.humanError(caught));
    } finally {
      setReplaying(null);
    }
  }

  return (
    <Card>
      <section id="whatsapp-history" aria-label="Загрузка истории WhatsApp">
        <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700 }}>История WhatsApp</div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '6px 0' }}>
              Запросить старые сообщения последних доступных чатов. До 50 сообщений на чат за один запуск.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!readOnly && <>
              <label>Чатов{' '}
                <select aria-label="Количество чатов для загрузки" value={active ? run.limit : limit}
                  disabled={submitting || active} onChange={(event) => setLimit(Number(event.target.value) as 100 | 200)}>
                  <option value={100}>Последние 100</option><option value={200}>Последние 200</option>
                </select>
              </label>
              <button type="button" className="btn-sm" disabled={submitting || active || !connected || !!status.error}
                onClick={() => void start()}>
                {submitting ? 'Запрашиваем…' : active ? 'Запрос выполняется…' : 'Загрузить историю'}
              </button>
            </>}
            <button type="button" className="btn-sm" disabled={status.refreshing} onClick={status.reload}>Обновить статус</button>
          </div>
        </div>
        {status.data && <div style={{ fontSize: 12 }}>
          Живых подключений: {status.data.connectedNumbers} · доступных чатов: {status.data.availableChats}
        </div>}
        {!status.loading && !connected && !status.error && <p style={{ fontSize: 12 }}>
          Нет активного соединения WhatsApp. <Link to="../integrations">Проверить подключение</Link>.
        </p>}
        {status.data?.availableChats === 0 && <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Первичная история ещё не получена. WhatsApp должен сначала передать список чатов и сообщения.
          Эта кнопка не может прочитать неизвестные серверу переписки или восстановить резервную копию телефона.
        </p>}
        {run && <div role="status" aria-live="polite" style={{ fontSize: 12, marginTop: 10 }}>
          <strong>{historyRunLabel(run.status)}</strong>
          <div>Выбор запуска: последние {run.limit} доступных чатов.</div>
          <div>Запрошено чатов: {run.requestedChats}/{run.totalChats} · ответили: {run.receivedChats} · сообщений в ответах: {run.receivedMessages} · ошибок: {run.failedChats}</div>
          {run.error && <div style={{ color: 'var(--danger)' }}>{run.error}</div>}
          <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>
            Ответ WhatsApp ещё не означает сохранение всех сообщений. Проверяйте результат в диалогах.
            Обновление списка не запускает повторный импорт.
          </div>
        </div>}
        {(archive.data?.length ?? 0) > 0 && <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Сохранённые пакеты истории</div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 8px' }}>
            Исходные данные хранятся зашифрованно до указанной даты. Повторная обработка не требует нового QR.
            Счётчики показывают последнюю обработку; при повторе уже сохранённые сообщения станут дубликатами.
          </p>
          {archive.data!.map((packet) => <div key={packet.id} style={{
            borderTop: '1px solid var(--border)', padding: '8px 0', fontSize: 12,
          }}>
            <div><strong>{archiveStatus(packet.status)}</strong> · попыток: {packet.attempts}</div>
            <div>
              Получено: {packet.counts.received} · Сохранено: {packet.counts.saved} · Дубликаты: {packet.counts.duplicates}
              {' · '}Исключено: {packet.counts.excluded} · Без номера: {packet.counts.skippedUnresolved}
            </div>
            <div style={{ color: 'var(--text-dim)' }}>{new Date(packet.expiresAt).getTime() <= Date.now()
              ? 'Срок хранения истёк — повторная обработка недоступна.'
              : `Повтор доступен до ${new Date(packet.expiresAt).toLocaleString('ru-RU')}.`}</div>
            {packet.errorCode && <div style={{ color: 'var(--danger)' }}>Код ошибки: {packet.errorCode}</div>}
            {!readOnly && packet.canReplay && <button type="button" className="btn-sm"
              disabled={replaying !== null} onClick={() => void replay(packet.id)} style={{ marginTop: 6 }}>
              {replaying === packet.id ? 'Ставим в очередь…' : 'Повторить обработку'}
            </button>}
          </div>)}
        </div>}
        {archive.error !== undefined && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          Не удалось получить состояние сохранённой истории: {api.humanError(archive.error)}
        </div>}
        {(error !== null || status.error !== undefined) && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>
          {error ?? api.humanError(status.error)}
        </div>}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8 }}>
          Статус текущего запроса сбрасывается при перезапуске сервера. Сохранённые сообщения остаются.
        </div>
      </section>
    </Card>
  );
}

function archiveStatus(status: string): string {
  if (status === 'queued') return 'Ожидает обработки';
  if (status === 'processing') return 'Обрабатывается';
  if (status === 'partial') return 'Сохранено частично';
  if (status === 'failed') return 'Ошибка обработки';
  if (status === 'done') return 'Обработано';
  return 'Состояние неизвестно';
}
