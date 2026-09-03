import { useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { OrderDialog } from '@/components/lead/OrderDialog';
import { Card } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { countOrders } from '@/lib/orders';
import { useAgent } from '@/store/agent';
import type { Board, BoardCard, StageKind } from '@/types';

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** The column without a stage: everyone nobody has sorted yet lands here. */
const UNSORTED = 'unsorted';

/** What exactly is being dragged: the card and the column it was taken from. */
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
  /** The conversation whose order form is open, or null. Set only by a landed sale. */
  const [prompting, setPrompting] = useState<string | null>(null);

  const board = useApi<Board>((signal) => api.getBoard(agent.id, signal), [agent.id]);

  /**
   * End of a drag without a drop: Esc, or releasing outside every column.
   *
   * Without this, `dragging` stays populated forever, and the next thing
   * dropped on a column — a file, selected text — would silently move that
   * card.
   */
  function endDrag() {
    setDragging(null);
    setOver(null);
  }

  /**
   * Whether to ask for the money after a card has landed in the sale column.
   *
   * The board's cards do not carry their orders, so the count comes from a read of the
   * lead — the same test the lead card makes: a lead that already recorded a purchase is
   * not asked again, and a cancelled order does not count as one.
   *
   * When that read fails we ask anyway. The form records nothing until a person types an
   * amount into it, so a needless prompt costs one «Не сейчас», while staying quiet costs
   * the sale its money — and that money is what stage 6 reports to Meta.
   */
  async function shouldPrompt(conversationId: string): Promise<boolean> {
    try {
      return countOrders(await api.getLead(agent.id, conversationId)) === 0;
    } catch {
      return true;
    }
  }

  async function drop(stageId: string | null, kind: StageKind | null) {
    const card = dragging;
    // We always clear the highlight, before any checks: dragleave does not fire
    // on a drop, and otherwise the column would stay outlined with dashes until
    // the next hover.
    endDrag();
    if (card === null) return;
    // The server treats a drop into the same column as no transition and sends
    // nothing back, but there is no reason to make the round trip for that either.
    if (card.stageId === stageId) return;

    setMoving(true);
    try {
      await api.setLeadStage(agent.id, card.conversationId, stageId);
      // We reload the whole board instead of moving the card in place: the
      // transition can send an auto-message, and that changes both the card's
      // preview and its ordering.
      board.reload();
      // Only after the server confirms the move. A form opened over a drop the server
      // refused — the board says so with a toast — would have the operator record real
      // money against a lead that never left its column.
      if (kind === 'success' && (await shouldPrompt(card.conversationId))) {
        setPrompting(card.conversationId);
      }
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
          {/* There is data on screen, but the last attempt to refresh it failed.
              Async keeps the previous response in that case, and without this line
              a card just sits silently in its old column after a failed reload. */}
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
              onDrop={() => drop(null, null)}
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
                onDrop={() => drop(column.stage.id, column.stage.kind)}
                onDragStart={(conversationId, stageId) => setDragging({ conversationId, stageId })}
                onDragEnd={endDrag}
              />
            ))}
          </div>

          {prompting !== null && (
            <OrderDialog
              agentId={agent.id}
              conversationId={prompting}
              currency={data.currency}
              order={null}
              // Zero by design: the form is only offered to a lead that has no order
              // standing, so the «уже есть заказы» line has nothing to say here.
              existingOrders={0}
              onClose={() => setPrompting(null)}
              onSaved={() => {
                // The card carries the lead's total, and the order just changed it.
                board.reload();
                setPrompting(null);
              }}
            />
          )}
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
  /** The column's stage; null for "No stage". `id` differs from it only there. */
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
      // preventDefault on dragOver is the only way to tell the browser that a
      // drop is allowed here. Without it, drop never fires at all.
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        onDragOver(id);
      }}
      onDragLeave={(event: DragEvent) => {
        // dragleave bubbles up from cards inside the column, so moving the cursor
        // over them would otherwise toggle the highlight off and on for each one.
        // We only count it as leaving once the cursor exits the column itself.
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
    // The card has no padding of its own: the padding, the cursor, and the
    // handlers all live on the draggable element. Otherwise the card's outer
    // edge would show a "grab" cursor, but dragging from it would not start.
    <Card pad={false}>
      <div
        draggable
        // draggable + dataTransfer: without setData, Firefox never starts the
        // drag at all. We read the value from the screen's state instead — it's
        // simpler, and it's already there.
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
          {/* An empty preview means different things: a conversation with not a single
              message has no last-message time either, while a message with a photo has
              no text. We branch on the time, not the preview — otherwise a brand-new
              lead would look like one who sent an attachment. */}
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
          {/* We don't show zero: blank space is more honest than «0 ₸» for someone who
              hasn't bought anything yet. */}
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
