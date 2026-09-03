### Task 8: The board screen

**Files:**
- Create: `rakurs/src/screens/BoardScreen.tsx`
- Create: `rakurs/src/lib/money.ts`
- Modify: `rakurs/src/api/index.ts` (the funnel calls)
- Modify: `rakurs/src/lib/sections.ts` (`orders` loses its placeholder, `customers` appears)
- Modify: `rakurs/src/App.tsx` (route the two new screens)

**Interfaces:**
- Consumes: `GET /api/agents/:agentId/board` and `PATCH /api/agents/:agentId/conversations/:conversationId/lead` from tasks 4 and 7; `useApi`, `Async`, `Skeleton`, `Card`, `useToast`, `useAgent`.
- Produces: `formatMoney(amount, currency)` in `rakurs/src/lib/money.ts`, used again by tasks 9 and 10; the API functions `getBoard`, `setLeadStage`, `listCustomers`, `customersCsvUrl`, `getLead`, `assignLead`, `setLeadField`, `addNote`, `listMembers`, `listStages`, `listLeadFields`, `createOrder`, `updateOrder`, `deleteOrder`.

**Context.** The first screen the cabinet opens on. Nine columns, a card per conversation, and the gesture a board teaches: drag a card into the next column.

Task 10 builds the customers screen and task 9 the lead panel, so this task adds every API function the three of them need at once — a thin transport layer split across three tasks would be three edits to the same twenty lines.

**Drag and drop, by hand.** The HTML5 drag events do everything needed here: `draggable` on the card, `onDragOver` with `preventDefault` on the column, `onDrop` reading the id. No library. Desktop only, as the whole cabinet is, and a select on the card is the way a lead moves without a mouse.

**After a drop.** The move is sent, then the board is reloaded — not patched in place. A drop can fire a stage template, which adds a message, which changes the card's preview and the sort order. A local patch would be wrong about all three.

- [ ] **Step 1: Write the money formatter**

Create `rakurs/src/lib/money.ts`:

```ts
/**
 * Суммы приходят с сервера строкой: `numeric` не проходит через float ни на одном
 * шаге, потому что 1234567.89 в double уже не 1234567.89.
 *
 * Форматируем строку, а не число: разбиваем на рубли и копейки по точке и ставим
 * узкие пробелы между разрядами. Копейки показываем только если они есть — в тенге
 * их не бывает, и «450 000,00 ₸» в списке читается хуже, чем «450 000 ₸».
 */

const SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', UZS: 'сўм' };

export function formatMoney(amount: string, currency: string): string {
  const [whole = '0', cents = '00'] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const tail = cents === '00' ? '' : `,${cents}`;
  return `${grouped}${tail} ${SYMBOLS[currency] ?? currency}`;
}
```

- [ ] **Step 2: Add the API calls**

In `rakurs/src/api/index.ts`, add the types to the import list at the top —
`Board`, `Customer`, `Lead`, `LeadField`, `Member`, `Stage` — and append:

```ts
// ── Воронка ──────────────────────────────────────────────────────────────────

export const getBoard = (agentId: string, signal?: AbortSignal) =>
  request<Board>(`/agents/${agentId}/board`, { signal });

export const listCustomers = (agentId: string, signal?: AbortSignal) =>
  request<Customer[]>(`/agents/${agentId}/customers`, { signal });

/** Адрес выгрузки. Доступ проверяется той же сессионной кукой, что и всё остальное. */
export const customersCsvUrl = (agentId: string) => `${API_URL}/agents/${agentId}/customers.csv`;

export const listStages = (agentId: string, signal?: AbortSignal) =>
  request<Stage[]>(`/agents/${agentId}/stages`, { signal });

export const createStage = (
  agentId: string,
  body: { name: string; color: string; kind: Stage['kind'] },
) => request<Stage>(`/agents/${agentId}/stages`, { method: 'POST', body });

export const updateStage = (
  agentId: string,
  stageId: string,
  body: Partial<Pick<Stage, 'name' | 'color' | 'kind' | 'description' | 'autoMessage'>>,
) => request<Stage>(`/agents/${agentId}/stages/${stageId}`, { method: 'PATCH', body });

export const deleteStage = (agentId: string, stageId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/stages/${stageId}`, { method: 'DELETE' });

export const reorderStages = (agentId: string, ids: string[]) =>
  request<Stage[]>(`/agents/${agentId}/stages/order`, { method: 'POST', body: { ids } });

export const listLeadFields = (agentId: string, signal?: AbortSignal) =>
  request<LeadField[]>(`/agents/${agentId}/lead-fields`, { signal });

export const createLeadField = (
  agentId: string,
  body: { name: string; kind: LeadField['kind']; hint: string },
) => request<LeadField>(`/agents/${agentId}/lead-fields`, { method: 'POST', body });

export const deleteLeadField = (agentId: string, fieldId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/lead-fields/${fieldId}`, { method: 'DELETE' });

export const listMembers = (agentId: string, signal?: AbortSignal) =>
  request<Member[]>(`/agents/${agentId}/members`, { signal });

// ── Карточка лида ────────────────────────────────────────────────────────────

const leadPath = (agentId: string, conversationId: string) =>
  `/agents/${agentId}/conversations/${conversationId}/lead`;

export const getLead = (agentId: string, conversationId: string, signal?: AbortSignal) =>
  request<Lead>(leadPath(agentId, conversationId), { signal });

/** `null` убирает лид из воронки; отсутствие поля оставляет стадию как была. */
export const setLeadStage = (agentId: string, conversationId: string, stageId: string | null) =>
  request<Lead>(leadPath(agentId, conversationId), { method: 'PATCH', body: { stageId } });

export const assignLead = (agentId: string, conversationId: string, assignedTo: string | null) =>
  request<Lead>(leadPath(agentId, conversationId), { method: 'PATCH', body: { assignedTo } });

/** Пустая строка стирает ответ: незаполненное поле и поле с пустым ответом — одно и то же. */
export const setLeadField = (
  agentId: string,
  conversationId: string,
  fieldId: string,
  value: string,
) =>
  request<Lead>(`${leadPath(agentId, conversationId)}/fields/${fieldId}`, {
    method: 'PUT',
    body: { value },
  });

export const addNote = (agentId: string, conversationId: string, body: string) =>
  request<Lead>(`/agents/${agentId}/conversations/${conversationId}/notes`, {
    method: 'POST',
    body: { body },
  });

// ── Заказы ───────────────────────────────────────────────────────────────────

export const createOrder = (
  agentId: string,
  conversationId: string,
  body: { amount: string; status: 'pending' | 'paid'; comment: string },
) =>
  request<Lead>(`/agents/${agentId}/conversations/${conversationId}/orders`, {
    method: 'POST',
    body,
  });

export const updateOrder = (
  agentId: string,
  orderId: string,
  body: { amount?: string; status?: 'pending' | 'paid' | 'cancelled'; comment?: string },
) => request<Lead>(`/agents/${agentId}/orders/${orderId}`, { method: 'PATCH', body });

export const deleteOrder = (agentId: string, orderId: string) =>
  request<Lead>(`/agents/${agentId}/orders/${orderId}`, { method: 'DELETE' });
```

- [ ] **Step 3: Route the new screens**

In `rakurs/src/lib/sections.ts`, replace the `orders` entry and add `customers` after
`dialogs`:

```ts
  { path: 'orders', label: 'Заказы', pending: '' },
```

```ts
  { path: 'customers', label: 'Клиенты', pending: '' },
```

In `rakurs/src/App.tsx`, add the imports and two more branches to the element chain:

```ts
import { BoardScreen } from '@/screens/BoardScreen';
import { CustomersScreen } from '@/screens/CustomersScreen';
```

```tsx
              section.path === 'settings' ? (
                <AgentSettingsScreen />
              ) : section.path === 'integrations' ? (
                <IntegrationsScreen />
              ) : section.path === 'dialogs' ? (
                <DialogsScreen />
              ) : section.path === 'orders' ? (
                <BoardScreen />
              ) : section.path === 'customers' ? (
                <CustomersScreen />
              ) : (
                <SectionScreen section={section} />
              )
```

`CustomersScreen` arrives in task 10. Until then this file will not compile, so create a
placeholder now and let task 10 replace it — `rakurs/src/screens/CustomersScreen.tsx`:

```tsx
import { Card } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';

export function CustomersScreen() {
  return (
    <Card>
      <EmptyState>Таблица клиентов появится следующей задачей.</EmptyState>
    </Card>
  );
}
```

- [ ] **Step 4: Write the board**

Create `rakurs/src/screens/BoardScreen.tsx`:

```tsx
import { useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
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

export function BoardScreen() {
  const { agent } = useAgent();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const board = useApi<Board>((signal) => api.getBoard(agent.id, signal), [agent.id]);

  async function drop(stageId: string | null, conversationId: string) {
    setDragging(null);
    setOver(null);
    setMoving(true);
    try {
      await api.setLeadStage(agent.id, conversationId, stageId);
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
            title="Без стадии"
            color="var(--line-strong)"
            cards={data.unsorted}
            currency={data.currency}
            over={over === UNSORTED}
            onDragOver={setOver}
            onDrop={() => dragging && drop(null, dragging)}
            onDragStart={setDragging}
          />
          {data.columns.map((column) => (
            <Column
              key={column.stage.id}
              id={column.stage.id}
              title={column.stage.name}
              color={column.stage.color}
              cards={column.cards}
              currency={data.currency}
              over={over === column.stage.id}
              onDragOver={setOver}
              onDrop={() => dragging && drop(column.stage.id, dragging)}
              onDragStart={setDragging}
            />
          ))}
        </div>
      )}
    </Async>
  );
}

function Column({
  id,
  title,
  color,
  cards,
  currency,
  over,
  onDragOver,
  onDrop,
  onDragStart,
}: {
  id: string;
  title: string;
  color: string;
  cards: BoardCard[];
  currency: string;
  over: boolean;
  onDragOver: (id: string | null) => void;
  onDrop: () => void;
  onDragStart: (conversationId: string) => void;
}) {
  return (
    <div
      // preventDefault на dragOver — единственный способ сказать браузеру, что сюда
      // можно бросать. Без него drop не сработает вообще.
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        onDragOver(id);
      }}
      onDragLeave={() => onDragOver(null)}
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
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          {cards.length}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cards.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '10px 6px' }}>
            Пусто
          </div>
        ) : (
          cards.map((card) => (
            <Lead key={card.conversationId} card={card} currency={currency} onDragStart={onDragStart} />
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
}: {
  card: BoardCard;
  currency: string;
  onDragStart: (conversationId: string) => void;
}) {
  const navigate = useNavigate();

  return (
    <Card
      pad={false}
      style={{ padding: '10px 12px', cursor: 'grab' }}
      // draggable + dataTransfer: без setData Firefox не начинает перетаскивание вовсе.
      // Значение при этом читаем из состояния экрана — так проще, и оно уже там есть.
    >
      <div
        draggable
        onDragStart={(event: DragEvent) => {
          event.dataTransfer.setData('text/plain', card.conversationId);
          event.dataTransfer.effectAllowed = 'move';
          onDragStart(card.conversationId);
        }}
        onClick={() => navigate(`../dialogs?conversation=${card.conversationId}`)}
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
          {card.preview ?? 'Вложение'}
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
```

- [ ] **Step 5: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
npm --prefix server run typecheck
```

- [ ] **Step 6: Look at it**

Start the stack as `README.md` describes, sign in, open Заказы. With no conversations the
board shows nine empty columns and Без стадии. There is nothing to drag yet; task 9 gives
the panel that puts a lead in a stage without a mouse, and the live check at the end of
the plan is where a real card gets dragged.

- [ ] **Step 7: Commit**

```bash
git add rakurs/src/screens/BoardScreen.tsx rakurs/src/screens/CustomersScreen.tsx rakurs/src/lib/money.ts rakurs/src/api/index.ts rakurs/src/lib/sections.ts rakurs/src/App.tsx
git commit -m "Show the funnel as a board of draggable cards"
```
