import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { LeadPanel } from '@/components/lead/LeadPanel';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi, type ApiState } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { formatPhone, phoneDigits } from '@/lib/phone';
import { useAgent } from '@/store/agent';
import type { Board, BoardCard } from '@/types';
import { ConversationThreadView } from './DialogsScreen';
import './board.css';

const UNSORTED = 'unsorted';
type EnrichedCard = BoardCard & { crmSummary?: string | null; stageSetBy?: string | null; sourceLabel?: string | null; analysisStatus?: string | null };
type Dragged = { conversationId: string; stageId: string | null };
const instagramIdentity = (value: string) => value.startsWith('@') ? value : `@${value}`;

/** Refresh quietly without interrupting active requests or card interaction. */
export function useVisibleRefresh<T>(state: ApiState<T>, paused = false) {
  const latest = useRef({ state, paused });
  latest.current = { state, paused };
  useEffect(() => {
    const refresh = () => {
      const { state: current, paused: stopped } = latest.current;
      if (document.visibilityState === 'visible' && !current.loading && !stopped) current.reload();
    };
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
}

export function matchesBoardSearch(card: EnrichedCard, search: string) {
  const query = search.trim().toLocaleLowerCase('ru');
  const digits = phoneDigits(query);
  return !query || (digits.length >= 4 && phoneDigits(card.contactPhone ?? '').includes(digits)) || [card.contactName, card.channel === 'instagram' ? instagramIdentity(card.contactAddress) : card.contactAddress, card.preview, card.crmSummary, card.sourceLabel, card.adHeadline, card.assigneeName]
    .some((value) => value?.toLocaleLowerCase('ru').includes(query));
}

export function BoardScreen() {
  const { agent } = useAgent();
  const toast = useToast();
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [search, setSearch] = useState('');
  const [params, setParams] = useSearchParams();
  const selected = params.get('conversation');
  const opener = useRef<HTMLElement | null>(null);
  const dragged = useRef(false);
  const board = useApi<Board>((signal) => api.getBoard(agent.id, signal), [agent.id]);
  useVisibleRefresh(board, moving || dragging !== null);

  const closeConversation = useCallback(() => {
    setParams((current) => { const next = new URLSearchParams(current); next.delete('conversation'); next.delete('message'); return next; }, { replace: true });
    window.requestAnimationFrame(() => opener.current?.focus());
  }, [setParams]);

  function endDrag() { setDragging(null); setOver(null); }
  async function move(card: Dragged, stageId: string | null) {
    endDrag();
    if (moving || card.stageId === stageId) return;
    setMoving(true);
    try {
      await api.setLeadStage(agent.id, card.conversationId, stageId);
      board.reload();
    } catch (error) { toast.fail(error); }
    finally { setMoving(false); }
  }

  return <Async state={board} skeleton={<Skeleton height={420} />}>
    {(data) => {
      const all: EnrichedCard[] = [...data.unsorted, ...data.columns.flatMap((column) => column.cards)];
      const pending = all.filter((card) => ['pending', 'running', 'processing', 'queued'].includes(card.analysisStatus ?? '')).length;
      const failed = all.filter((card) => ['failed', 'error'].includes(card.analysisStatus ?? '')).length;
      const visibleCount = all.filter((card) => matchesBoardSearch(card, search)).length;
      const columns = [
        ...(data.unsorted.length ? [{ id: UNSORTED, name: 'Требуют разбора', color: 'var(--text-dim)', cards: data.unsorted }] : []),
        ...data.columns.map(({ stage, cards }) => ({ id: stage.id, name: stage.name, color: stage.color, cards })),
      ];
      return <div className="funnel-screen">
        <div className="funnel-toolbar">
          <div><h2>Все сделки — по этапам</h2><p>Откройте диалог или переместите карточку на нужный этап.</p></div>
          <Link className="btn" to="../settings">Настроить этапы</Link>
        </div>
        <div className="funnel-controls">
          <label className="funnel-search"><span aria-hidden="true">⌕</span><input aria-label="Поиск по воронке" placeholder="Имя, телефон, сообщение…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button type="button" aria-label="Очистить поиск" onClick={() => setSearch('')}>×</button>}</label>
          <span className="funnel-total">Сделки: {search ? `${visibleCount} из ${all.length}` : all.length}</span>
          <span className="funnel-sync" role="status">{data.analysisConfigured === false ? 'Добавьте ключ ИИ в настройках агента' : moving ? 'Сохраняем этап…' : data.crmAnalysisMode !== 'independent' ? 'Анализ следует режиму AI' : pending ? `ИИ разбирает: ${pending}` : failed ? `Не удалось разобрать: ${failed}` : board.loading ? 'Обновляем…' : 'Автообновление включено'}</span>
        </div>
        {board.error !== undefined && <div className="funnel-error" role="alert">Не удалось обновить воронку. Показаны последние данные. <button className="btn" onClick={board.reload}>Повторить</button></div>}
        {all.length === 0 && <p className="funnel-empty-note">Здесь появятся сделки из диалогов с клиентами.</p>}
        {search && visibleCount === 0 && <p className="funnel-empty-note">По этому запросу сделок нет. Попробуйте другое имя или телефон.</p>}
        <div className="funnel-board" aria-label="Этапы воронки" tabIndex={0}>
          {columns.map((column) => {
            const cards = column.cards.filter((card) => matchesBoardSearch(card, search));
            const stageId = column.id === UNSORTED ? null : column.id;
            return <section key={column.id} className={`funnel-column${over === column.id ? ' is-over' : ''}`} style={{ '--stage-color': column.color } as CSSProperties}
              onDragOver={(event: DragEvent) => { if (!dragging || moving) return; event.preventDefault(); setOver(column.id); }}
              onDragLeave={(event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}
              onDrop={(event: DragEvent) => { event.preventDefault(); if (dragging) void move(dragging, stageId); }}>
              <header className="funnel-column-heading"><span className="funnel-stage-dot" /><h3>{column.name}</h3><span className="funnel-count">{cards.length}</span></header>
              <div className="funnel-column-body">
                {cards.length === 0 ? <div className="funnel-column-empty">{search ? 'Нет совпадений' : 'Пока нет сделок'}</div> : cards.map((card: EnrichedCard) => <article className="funnel-card" key={card.conversationId} draggable={!moving}
                  onDragStart={(event) => { dragged.current = true; event.dataTransfer.setData('text/plain', card.conversationId); event.dataTransfer.effectAllowed = 'move'; setDragging({ conversationId: card.conversationId, stageId }); }} onDragEnd={() => { endDrag(); window.setTimeout(() => { dragged.current = false; }, 0); }}>
                  <button type="button" className="funnel-card-link" aria-label={`Открыть чат с ${card.channel === 'instagram' ? instagramIdentity(card.contactAddress) : formatPhone(card.contactPhone)}`}
                    onClick={(event: MouseEvent<HTMLButtonElement>) => { if (dragged.current) return; opener.current = event.currentTarget; setParams((current) => { const next = new URLSearchParams(current); next.set('conversation', card.conversationId); return next; }, { replace: true }); }}>
                    <div className="funnel-card-top"><span className="funnel-avatar" aria-hidden="true">{card.channel === 'instagram' ? '◎' : '☎'}</span><div><h4>{card.channel === 'instagram' ? instagramIdentity(card.contactAddress) : formatPhone(card.contactPhone)}</h4>{card.channel === 'instagram' && <small>{card.contactName && card.contactName !== card.contactAddress ? `${card.contactName} · ` : ''}Instagram</small>}</div>{!card.windowOpen && <span className="funnel-window" title="Окно ответа закрыто">◷</span>}</div>
                    <p className="funnel-preview">{card.crmSummary || card.preview || (card.lastMessageAt ? 'Вложение' : 'Сообщений нет')}</p>
                    {(card.sourceLabel || card.adHeadline) && <span className="funnel-source">{card.sourceLabel || `Реклама · ${card.adHeadline}`}</span>}
                    <div className="funnel-card-meta">{Number(card.paidTotal) > 0 && <strong>{formatMoney(card.paidTotal, data.currency)}</strong>}{card.assigneeName && <span>{card.assigneeName}</span>}<time dateTime={card.lastMessageAt ?? undefined}>{card.lastMessageAt ? new Date(card.lastMessageAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</time></div>
                  </button>
                  <div className="funnel-card-footer"><span title="Кто установил текущий этап">{card.stageSetBy === 'ai' || card.stageSetBy === 'crm' ? '✦ ИИ' : card.stageSetBy === 'manual' || card.stageSetBy === 'user' ? 'Вручную' : 'Этап'}</span><select aria-label={`Этап сделки ${card.channel === 'instagram' ? instagramIdentity(card.contactAddress) : formatPhone(card.contactPhone)}`} value={stageId ?? UNSORTED} disabled={moving} onChange={(event) => void move({ conversationId: card.conversationId, stageId }, event.target.value === UNSORTED ? null : event.target.value)}><option value={UNSORTED}>Требуют разбора</option>{data.columns.map(({ stage }) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></div>
                </article>)}
              </div>
            </section>;
          })}
        </div>
        <div className="funnel-footnote">Оплаченные покупки — в разделе <Link to="../orders">Заказы</Link>. Этап сделки сам по себе не подтверждает оплату.</div>
        {selected && <ConversationModal agentId={agent.id} conversationId={selected} targetMessageId={params.get('message')} onClose={closeConversation} onChanged={board.reload} />}
      </div>;
    }}
  </Async>;
}

function ConversationModal({agentId,conversationId,targetMessageId,onClose,onChanged}:{agentId:string;conversationId:string;targetMessageId:string|null;onClose:()=>void;onChanged:()=>void}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter((item) => !item.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', keydown); };
  }, [onClose]);
  return <div className="conversation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="conversation-modal" role="dialog" aria-modal="true" aria-label="Чат с клиентом" tabIndex={-1}>
      <header><h2>Чат с клиентом</h2><button type="button" className="conversation-close" aria-label="Закрыть чат" onClick={onClose}>×</button></header>
      <div className="conversation-workspace"><ConversationThreadView agentId={agentId} conversationId={conversationId} targetMessageId={targetMessageId} onSent={onChanged} onAiChanged={onChanged} /><LeadPanel agentId={agentId} conversationId={conversationId} onChanged={onChanged} /></div>
    </div>
  </div>;
}
