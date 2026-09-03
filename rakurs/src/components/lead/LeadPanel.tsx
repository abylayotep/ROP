import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { OrderDialog } from '@/components/lead/OrderDialog';
import { Card, Divider, Toggle } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { countOrders } from '@/lib/orders';
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

/** The height of one `control`, so its skeleton does not shift the rows below it. */
const CONTROL_HEIGHT = 34;

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
  /** The thread and the board show the same data — after a change they must reread theirs. */
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
   * The one way to apply a change: the server answers with the whole lead, and we store
   * it whole. Patching fields in place is not allowed — a stage transition can append a
   * note about an auto-message, and a lead we assembled ourselves would misreport what
   * was actually sent to the client.
   *
   * Answers with the new lead, or null when the request failed, because callers have to
   * know: a caller that assumes success shows the operator something that never happened.
   */
  async function apply(action: () => Promise<Lead>): Promise<Lead | null> {
    try {
      const next = await action();
      setLead(next);
      onChanged();
      return next;
    } catch (error) {
      toast.fail(error);
      query.reload();
      return null;
    }
  }

  async function move(stageId: string) {
    const next = stageId === '' ? null : stageId;
    const moved = await apply(() => api.setLeadStage(agentId, conversationId, next));

    // Only prompt for the money once the server confirms the lead is actually in the
    // sale stage. Prompting after a failed move would have the operator record a real
    // order against a lead that never moved: the money counted, the funnel not.
    if (moved === null || moved.stageId !== next) return;

    const stage = stages.data?.find((item) => item.id === next);
    // A sale with no order is an honest state: the funnel counts the conversion and the
    // money stays zero. So the form is offered, never filled in silently. A lead that
    // already carries orders is not asked again — the button above the list is there for
    // a second purchase.
    // A cancelled order does not count as money recorded, so a lead whose only order fell
    // through is still asked for one.
    if (stage?.kind === 'success' && countOrders(moved) === 0) setPrompting(true);
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
              {/* Gated on the stage list rather than rendered around it: an empty select
                  would read «Без стадии» for a lead that has one, which is a confident
                  wrong answer where a skeleton says the truth. */}
              <Async state={stages} skeleton={<Skeleton height={CONTROL_HEIGHT} />} compactError>
                {(list) => (
                  <select
                    style={control}
                    value={lead.stageId ?? ''}
                    onChange={(e) => move(e.target.value)}
                  >
                    <option value="">Без стадии</option>
                    {list.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name}
                      </option>
                    ))}
                  </select>
                )}
              </Async>
              {lead.stageSetAt && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
                  {when(lead.stageSetAt)}
                  {lead.stageSetBy === 'operator' ? ' · вручную' : ''}
                </div>
              )}
            </div>

            {/* Beside the stage, where an operator is already looking when they decide to
                step in. Any member may flip it: waiting for an owner to log in is not an
                option mid-conversation. */}
            <AiSwitch
              agentId={agentId}
              conversationId={conversationId}
              on={lead.aiEnabled}
              onSet={(aiEnabled) => setLead({ ...lead, aiEnabled })}
              onFailed={query.reload}
            />

            <div>
              <div style={label}>Ответственный</div>
              {/* Same reason: without the member list an assigned lead reads «Никто». */}
              <Async state={members} skeleton={<Skeleton height={CONTROL_HEIGHT} />} compactError>
                {(list) => (
                  <select
                    style={control}
                    value={lead.assignedTo ?? ''}
                    onChange={(e) =>
                      apply(() => api.assignLead(agentId, conversationId, e.target.value || null))
                    }
                  >
                    <option value="">Никто</option>
                    {list.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                )}
              </Async>
            </div>

            <Divider />

            <Orders
              lead={lead}
              onAdd={() => setPrompting(true)}
              onEdit={setEditing}
              onDelete={(orderId) => apply(() => api.deleteOrder(agentId, orderId))}
            />

            <Divider />

            {/* And again: «Полей лида нет» is a claim about the account's settings, not a
                loading state, so it must not be made before the list has arrived. */}
            <Async state={fields} skeleton={<Skeleton height={60} />} compactError>
              {(list) => (
                <Fields
                  fields={list}
                  lead={lead}
                  onSet={async (fieldId, value) =>
                    (await apply(() => api.setLeadField(agentId, conversationId, fieldId, value))) !==
                    null
                  }
                />
              )}
            </Async>

            <Divider />

            <Notes
              lead={lead}
              onAdd={async (body) =>
                (await apply(() => api.addNote(agentId, conversationId, body))) !== null
              }
            />

            {(prompting || editing) && (
              <OrderDialog
                agentId={agentId}
                conversationId={conversationId}
                currency={lead.currency}
                order={editing}
                existingOrders={countOrders(lead)}
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

/**
 * «ИИ отвечает в этом диалоге».
 *
 * One thread, not the agent: the operator who sees the agent go wrong on one conversation
 * has to be able to stop it there without taking the agent off every other conversation in
 * the cabinet. It also goes off by itself when the agent hands a thread over, which is why
 * the switch shows what the server stored rather than what was clicked.
 */
function AiSwitch({
  agentId,
  conversationId,
  on,
  onSet,
  onFailed,
}: {
  agentId: string;
  conversationId: string;
  on: boolean;
  onSet: (aiEnabled: boolean) => void;
  onFailed: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function toggle() {
    if (saving) return;
    setSaving(true);
    try {
      // The route answers with the flag as stored, and that is what goes on screen: a
      // switch showing what was clicked would claim a change the server refused.
      const { aiEnabled } = await api.setConversationAi(agentId, conversationId, !on);
      onSet(aiEnabled);
    } catch (error) {
      toast.fail(error);
      onFailed();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 650 }}>ИИ отвечает в этом диалоге</span>
        <button
          type="button"
          className="btn-quiet"
          aria-pressed={on}
          disabled={saving}
          style={{ marginLeft: 'auto', display: 'flex', opacity: saving ? 0.5 : 1 }}
          onClick={toggle}
        >
          <Toggle on={on} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5, lineHeight: 1.45 }}>
        {on
          ? 'Выключите — и диалог останется человеку. Другие диалоги это не затронет.'
          : 'Отвечает человек. Другие диалоги агент ведёт как вёл.'}
      </div>
    </div>
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
                  onClick={() => {
                    // Deleting an order takes the money out of the funnel, the board and
                    // the customers table, and nothing brings it back but retyping it.
                    if (
                      !window.confirm(
                        `Удалить заказ на ${formatMoney(order.amount, order.currency)}? ` +
                          'Это нельзя отменить.',
                      )
                    ) {
                      return;
                    }
                    onDelete(order.id);
                  }}
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
  /** Answers whether the value reached the server, so a failed row can be put back. */
  onSet: (fieldId: string, value: string) => Promise<boolean>;
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
          key={field.id}
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
  onSet: (value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);

  // Saved on leaving the box rather than on every letter: otherwise typing one city is
  // five requests, and the fourth can overtake the fifth.
  async function commit() {
    // Trimmed the way the server stores it, so the box cannot disagree with the stored
    // value over a trailing space and resend the same text on every blur.
    const next = draft.trim();
    setDraft(next);
    if (next === value) return;
    // A row that kept the typed text after a refusal would go on showing a value the
    // server never stored, and nothing on screen would say so.
    if (!(await onSet(next))) setDraft(value);
  }

  return (
    <div>
      <div style={label}>{field.name}</div>
      <input
        style={control}
        type={field.kind === 'date' ? 'date' : field.kind === 'number' ? 'number' : 'text'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </div>
  );
}

function Notes({
  lead,
  onAdd,
}: {
  lead: Lead;
  /** Answers whether the note was stored: a lost note must stay in the box. */
  onAdd: (body: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || saving) return;

    setSaving(true);
    // Cleared only once the server has it. Emptying the box first would destroy a note
    // the network lost and leave the operator with a toast and nothing to retry.
    const added = await onAdd(draft);
    setSaving(false);
    if (added) setDraft('');
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 6 }}>Заметки</div>
      {/* Said outright: a text box beside a chat reads as a second send box. */}
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
        <button type="submit" className="btn-sm" disabled={saving || !draft.trim()}>
          {saving ? 'Сохраняем…' : 'Добавить'}
        </button>
      </form>
    </div>
  );
}
