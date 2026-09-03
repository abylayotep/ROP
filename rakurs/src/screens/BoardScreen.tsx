import { useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { useAgent } from '@/store/agent';
import type { Board, BoardCard } from '@/types';

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Колонка без стадии: сюда попадают все, кого ещё никто не разобрал. */
const UNSORTED = 'unsorted';

/** Что именно тащат: карточка и колонка, из которой её взяли. */
interface Dragged {
  conversationId: string;
  stageId: string | null;
}

export function BoardScreen() {
  const { agent } = useAgent();
  const toast = useToast();
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const board = useApi<Board>((signal) => api.getBoard(agent.id, signal), [agent.id]);

  /**
   * Конец перетаскивания без броска: Esc или мимо всех колонок.
   *
   * Без этого `dragging` остаётся заполненным навсегда, и следующее падение чего
   * угодно на колонку — файла, выделенного текста — молча переставит ту карточку.
   */
  function endDrag() {
    setDragging(null);
    setOver(null);
  }

  async function drop(stageId: string | null) {
    const card = dragging;
    // Подсветку снимаем всегда и до всех проверок: dragleave на броске не приходит,
    // и колонка иначе остаётся обведённой пунктиром до следующего наведения.
    endDrag();
    if (card === null) return;
    // Бросок в ту же колонку сервер обработает как отсутствие перехода и ничего не
    // отправит, но и ходить за этим на сервер незачем.
    if (card.stageId === stageId) return;

    setMoving(true);
    try {
      await api.setLeadStage(agent.id, card.conversationId, stageId);
      // Перезагружаем доску целиком, а не переставляем карточку на месте: переход
      // может отправить автосообщение, а оно меняет и превью карточки, и порядок.
      board.reload();
    } catch (error) {
      toast.fail(error);
    } finally {
      setMoving(false);
    }
  }

  return (
    <Async state={board} skeleton={<Skeleton height={340} />}>
      {(data) => (
        <>
          {/* Данные на экране есть, но последняя попытка их обновить не удалась.
              Async в этом случае оставляет прежний ответ, и без этой строки карточка
              после неудавшейся перезагрузки просто стоит в старой колонке молча. */}
          {board.error !== undefined && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 10,
                fontSize: 12,
                color: 'var(--danger)',
              }}
            >
              <span>Доска могла устареть: обновить её не удалось.</span>
              <button type="button" className="btn" onClick={board.reload}>
                Обновить
              </button>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              overflowX: 'auto',
              paddingBottom: 8,
              opacity: moving ? 0.7 : 1,
            }}
          >
            <Column
              id={UNSORTED}
              stageId={null}
              title="Без стадии"
              color="var(--line-strong)"
              cards={data.unsorted}
              currency={data.currency}
              over={over === UNSORTED}
              onDragOver={setOver}
              onDrop={() => drop(null)}
              onDragStart={(conversationId, stageId) => setDragging({ conversationId, stageId })}
              onDragEnd={endDrag}
            />
            {data.columns.map((column) => (
              <Column
                key={column.stage.id}
                id={column.stage.id}
                stageId={column.stage.id}
                title={column.stage.name}
                color={column.stage.color}
                cards={column.cards}
                currency={data.currency}
                over={over === column.stage.id}
                onDragOver={setOver}
                onDrop={() => drop(column.stage.id)}
                onDragStart={(conversationId, stageId) => setDragging({ conversationId, stageId })}
                onDragEnd={endDrag}
              />
            ))}
          </div>
        </>
      )}
    </Async>
  );
}

function Column({
  id,
  stageId,
  title,
  color,
  cards,
  currency,
  over,
  onDragOver,
  onDrop,
  onDragStart,
  onDragEnd,
}: {
  id: string;
  /** Стадия колонки; null у «Без стадии». `id` от неё отличается только там. */
  stageId: string | null;
  title: string;
  color: string;
  cards: BoardCard[];
  currency: string;
  over: boolean;
  onDragOver: (id: string | null) => void;
  onDrop: () => void;
  onDragStart: (conversationId: string, stageId: string | null) => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      // preventDefault на dragOver — единственный способ сказать браузеру, что сюда
      // можно бросать. Без него drop не сработает вообще.
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        onDragOver(id);
      }}
      onDragLeave={(event: DragEvent) => {
        // dragleave всплывает от карточек внутри колонки, поэтому проход курсора над
        // ними иначе гасил бы и зажигал подсветку на каждой. Уходом считаем только
        // выход за пределы самой колонки.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onDragOver(null);
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        onDrop();
      }}
      style={{
        width: 264,
        flex: '0 0 264px',
        borderRadius: 10,
        background: over ? 'rgba(13,150,104,0.08)' : 'transparent',
        outline: over ? '1px dashed var(--accent-2)' : '1px solid transparent',
        padding: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 6px 10px',
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: color, flex: '0 0 auto' }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 650 }}>{title}</span>
        <span
          className="mono"
          style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}
        >
          {cards.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cards.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '10px 6px' }}>Пусто</div>
        ) : (
          cards.map((card) => (
            <Lead
              key={card.conversationId}
              card={card}
              currency={currency}
              onDragStart={() => onDragStart(card.conversationId, stageId)}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Lead({
  card,
  currency,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  currency: string;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const navigate = useNavigate();

  return (
    // Карточка без своих отступов: и поля, и курсор, и обработчики живут на элементе
    // с draggable. Иначе внешняя кромка карточки показывала бы «схватить», но
    // перетаскивание с неё не начиналось бы.
    <Card pad={false}>
      <div
        draggable
        // draggable + dataTransfer: без setData Firefox не начинает перетаскивание вовсе.
        // Значение при этом читаем из состояния экрана — так проще, и оно уже там есть.
        onDragStart={(event: DragEvent) => {
          event.dataTransfer.setData('text/plain', card.conversationId);
          event.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={() => navigate(`../dialogs?conversation=${card.conversationId}`)}
        style={{ padding: '10px 12px', cursor: 'grab' }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>
            {card.contactName ?? card.contactPhone}
          </span>
          {!card.windowOpen && (
            <span
              title="Окно ответа закрыто: клиент не писал больше суток"
              style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}
            >
              ⏳
            </span>
          )}
        </div>

        <div className="ellipsis" style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 }}>
          {/* Пустое превью значит разное: у диалога без единого сообщения нет и времени
              последнего, а у сообщения с фотографией нет текста. Разводим по времени, а не
              по превью — иначе новый лид выглядит как приславший вложение. */}
          {card.lastMessageAt === null ? 'Сообщений нет' : (card.preview ?? 'Вложение')}
        </div>

        {card.adHeadline && (
          <div className="ellipsis" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
            Из рекламы: {card.adHeadline}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            marginTop: 8,
            fontSize: 11,
            color: 'var(--text-dim)',
          }}
        >
          {/* Ноль не показываем: пустое место честнее, чем «0 ₸» у того, кто ещё не покупал. */}
          {card.paidTotal !== '0.00' && (
            <span className="mono" style={{ color: 'var(--accent-2)', fontWeight: 700 }}>
              {formatMoney(card.paidTotal, currency)}
            </span>
          )}
          {card.assigneeName && <span className="ellipsis">{card.assigneeName}</span>}
          <span style={{ marginLeft: 'auto' }}>
            {card.lastMessageAt ? time(card.lastMessageAt) : ''}
          </span>
        </div>
      </div>
    </Card>
  );
}
