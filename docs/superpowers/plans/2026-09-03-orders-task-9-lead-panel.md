### Task 9: The lead panel

**Files:**
- Create: `rakurs/src/components/lead/OrderDialog.tsx` (its contents are in [task-9-order-dialog.md](2026-09-03-orders-task-9-order-dialog.md))
- Create: `rakurs/src/components/lead/LeadPanel.tsx`
- Modify: `rakurs/src/screens/DialogsScreen.tsx` (the panel beside the thread, and opening a conversation from the board)

**Interfaces:**
- Consumes: `getLead`, `setLeadStage`, `assignLead`, `setLeadField`, `addNote`, `listStages`, `listLeadFields`, `listMembers`, `createOrder`, `updateOrder`, `deleteOrder` from task 8; `formatMoney`; the contract types `Lead`, `Stage`, `LeadField`, `Member`, `Order`.
- Produces: `<OrderDialog>` and `<LeadPanel agentId conversationId onChanged>`; `DialogsScreen` reading `?conversation=` so a board card can open its thread.

**Context.** Everything about a lead that is not the messages: the stage, who is handling it, the fields the business asked for, the notes, and the money.

**One source of truth.** Every mutation on this panel answers with the whole `Lead`, so the panel holds one piece of state — the lead — and replaces it with what the server returned. No optimistic patching: the stage template can add a note, and a note the panel invented would be a lie about what was sent.

**The sale prompt.** Moving a lead into the stage of kind `success` opens the order form with the amount empty. Dismissing it leaves the lead in the sale stage with no order, which is the honest state the spec asks for: the funnel counts the conversion and the money stays zero.

- [ ] **Step 1: Write the order dialog**

Create `rakurs/src/components/lead/OrderDialog.tsx` with exactly the contents of
[task-9-order-dialog.md](2026-09-03-orders-task-9-order-dialog.md).

- [ ] **Step 2: Write the panel**

Create `rakurs/src/components/lead/LeadPanel.tsx`:

```tsx
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { OrderDialog } from '@/components/lead/OrderDialog';
import { Card, Divider } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import type { Lead, LeadField, Member, Order, Stage } from '@/types';

const label: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 5 };

const control: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const STATUS: Record<Order['status'], string> = {
  pending: 'Ожидает оплаты',
  paid: 'Оплачен',
  cancelled: 'Отменён',
};

export function LeadPanel({
  agentId,
  conversationId,
  onChanged,
}: {
  agentId: string;
  conversationId: string;
  /** Диалог и доска показывают те же данные — после изменения им нужно перечитать своё. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lead, setLead] = useState<Lead | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [editing, setEditing] = useState<Order | null>(null);

  const query = useApi<Lead>((signal) => api.getLead(agentId, conversationId, signal), [
    agentId,
    conversationId,
  ]);
  const stages = useApi<Stage[]>((signal) => api.listStages(agentId, signal), [agentId]);
  const fields = useApi<LeadField[]>((signal) => api.listLeadFields(agentId, signal), [agentId]);
  const members = useApi<Member[]>((signal) => api.listMembers(agentId, signal), [agentId]);

  useEffect(() => {
    if (query.data) setLead(query.data);
  }, [query.data]);

  /**
   * Один способ применить изменение: сервер отвечает всей карточкой, и мы кладём её
   * целиком. Дописывать поля на месте нельзя — переход стадии может добавить заметку
   * об автосообщении, и придуманная нами карточка соврала бы о том, что ушло клиенту.
   */
  async function apply(action: () => Promise<Lead>) {
    try {
      setLead(await action());
      onChanged();
    } catch (error) {
      toast.fail(error);
      query.reload();
    }
  }

  async function move(stageId: string) {
    const next = stageId === '' ? null : stageId;
    await apply(() => api.setLeadStage(agentId, conversationId, next));

    const stage = stages.data?.find((item) => item.id === next);
    // Продажа без заказа — честное состояние: воронка считает конверсию, деньги нулевые.
    // Поэтому форму предлагаем, но не создаём заказ молча.
    if (stage?.kind === 'success') setPrompting(true);
  }

  return (
    <Async state={query} skeleton={<Skeleton height={420} />}>
      {() =>
        lead === null ? (
          <Skeleton height={420} />
        ) : (
          <Card style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={label}>Стадия</div>
              <select style={control} value={lead.stageId ?? ''} onChange={(e) => move(e.target.value)}>
                <option value="">Без стадии</option>
                {(stages.data ?? []).map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </select>
              {lead.stageSetAt && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
                  {when(lead.stageSetAt)}
                  {lead.stageSetBy === 'operator' ? ' · вручную' : ''}
                </div>
              )}
            </div>

            <div>
              <div style={label}>Ответственный</div>
              <select
                style={control}
                value={lead.assignedTo ?? ''}
                onChange={(e) =>
                  apply(() => api.assignLead(agentId, conversationId, e.target.value || null))
                }
              >
                <option value="">Никто</option>
                {(members.data ?? []).map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </div>

            <Divider />

            <Orders
              lead={lead}
              onAdd={() => setPrompting(true)}
              onEdit={setEditing}
              onDelete={(orderId) => apply(() => api.deleteOrder(agentId, orderId))}
            />

            <Divider />

            <Fields
              fields={fields.data ?? []}
              lead={lead}
              onSet={(fieldId, value) =>
                apply(() => api.setLeadField(agentId, conversationId, fieldId, value))
              }
            />

            <Divider />

            <Notes lead={lead} onAdd={(body) => apply(() => api.addNote(agentId, conversationId, body))} />

            {(prompting || editing) && (
              <OrderDialog
                agentId={agentId}
                conversationId={conversationId}
                currency={lead.currency}
                order={editing}
                onClose={() => {
                  setPrompting(false);
                  setEditing(null);
                }}
                onSaved={(next) => {
                  setLead(next);
                  onChanged();
                  setPrompting(false);
                  setEditing(null);
                }}
              />
            )}
          </Card>
        )
      }
    </Async>
  );
}

function Orders({
  lead,
  onAdd,
  onEdit,
  onDelete,
}: {
  lead: Lead;
  onAdd: () => void;
  onEdit: (order: Order) => void;
  onDelete: (orderId: string) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 650 }}>Заказы</span>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-2)' }}>
          {formatMoney(lead.paidTotal, lead.currency)}
        </span>
        <button type="button" className="btn-sm" style={{ marginLeft: 'auto' }} onClick={onAdd}>
          Добавить
        </button>
      </div>

      {lead.orders.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Заказов пока нет.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {lead.orders.map((order) => (
            <div key={order.id} className="sunken-box" style={{ padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 700 }}>
                  {formatMoney(order.amount, order.currency)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{STATUS[order.status]}</span>
                <button
                  type="button"
                  className="btn-link"
                  style={{ marginLeft: 'auto', fontSize: 11 }}
                  onClick={() => onEdit(order)}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 11, color: 'var(--danger)' }}
                  onClick={() => onDelete(order.id)}
                >
                  Удалить
                </button>
              </div>
              {order.comment && (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
                  {order.comment}
                </div>
              )}
              {order.paidAt && (
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                  Оплачен {when(order.paidAt)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Fields({
  fields,
  lead,
  onSet,
}: {
  fields: LeadField[];
  lead: Lead;
  onSet: (fieldId: string, value: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
        Полей лида нет. Владелец заводит их в настройках.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {fields.map((field) => (
        <FieldRow
          // key по id поля: при переключении диалога значение должно перечитаться,
          // а не остаться от прошлого клиента.
          key={`${lead.conversationId}:${field.id}`}
          field={field}
          value={lead.values.find((entry) => entry.fieldId === field.id)?.value ?? ''}
          onSet={(value) => onSet(field.id, value)}
        />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  onSet,
}: {
  field: LeadField;
  value: string;
  onSet: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <div>
      <div style={label}>{field.name}</div>
      <input
        style={control}
        type={field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        // Сохраняем по уходу из поля, а не на каждую букву: иначе один ввод города
        // это пять запросов, и последний может обогнать предпоследний.
        onBlur={() => draft !== value && onSet(draft)}
      />
    </div>
  );
}

function Notes({ lead, onAdd }: { lead: Lead; onAdd: (body: string) => void }) {
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft('');
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6 }}>Заметки</div>
      {/* Сказано прямо: поле для текста рядом с чатом читается как ещё одно окно отправки. */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>
        Клиент их не видит.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 8 }}>
        {lead.notes.map((note) => (
          <div key={note.id} className="sunken-box" style={{ padding: '8px 10px' }}>
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{note.body}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
              {note.authorName ?? 'Кабинет'} · {when(note.createdAt)}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
        <input
          style={control}
          value={draft}
          placeholder="Что важно помнить"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn-sm" disabled={!draft.trim()}>
          Добавить
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Put the panel beside the thread**

In `rakurs/src/screens/DialogsScreen.tsx`:

Add the imports:

```tsx
import { useSearchParams } from 'react-router-dom';
import { LeadPanel } from '@/components/lead/LeadPanel';
```

Replace the `selected` state with one seeded from the URL, so a card on the board opens
its thread:

```tsx
  const [params, setParams] = useSearchParams();
  const selected = params.get('conversation');
  const select = (conversationId: string) =>
    setParams({ conversation: conversationId }, { replace: true });
```

Change the list button's handler from `onClick={() => setSelected(conversation.id)}` to
`onClick={() => select(conversation.id)}`.

Wrap the thread and the panel side by side, replacing the `<div style={{ flex: 1, minWidth: 0 }}>`
block's contents:

```tsx
      <div style={{ flex: 1, minWidth: 0 }}>
        {selected === null ? (
          <Card>
            <EmptyState>Выберите переписку слева.</EmptyState>
          </Card>
        ) : (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Thread
                key={selected}
                agentId={agent.id}
                conversationId={selected}
                onSent={list.reload}
              />
            </div>
            <div style={{ width: 300, flex: '0 0 300px' }}>
              {/* Тот же key, по той же причине: карточка другого клиента не должна
                  на мгновение показаться под чужим именем. */}
              <LeadPanel
                key={selected}
                agentId={agent.id}
                conversationId={selected}
                onChanged={list.reload}
              />
            </div>
          </div>
        )}
      </div>
```

- [ ] **Step 4: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

- [ ] **Step 5: Commit**

```bash
git add rakurs/src/components/lead rakurs/src/screens/DialogsScreen.tsx
git commit -m "Add the lead panel beside the thread"
```
