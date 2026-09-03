import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { LeadField, Stage } from '@/types';

const control: CSSProperties = {
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};

const KINDS: { id: Stage['kind']; label: string }[] = [
  { id: 'active', label: 'В работе' },
  { id: 'qualified', label: 'Квалифицирован' },
  { id: 'awaiting_payment', label: 'Ждёт оплаты' },
  { id: 'success', label: 'Продажа' },
  { id: 'failure', label: 'Отказ' },
];

const FIELD_KINDS: { id: LeadField['kind']; label: string }[] = [
  { id: 'text', label: 'Текст' },
  { id: 'number', label: 'Число' },
  { id: 'date', label: 'Дата' },
];

export function FunnelSettings() {
  const { agent, role } = useAgent();
  const readOnly = role !== 'owner';

  const stages = useApi<Stage[]>((signal) => api.listStages(agent.id, signal), [agent.id]);
  const fields = useApi<LeadField[]>((signal) => api.listLeadFields(agent.id, signal), [agent.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <CardHead title="Воронка" />
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 14 }}>
          Описание стадии прочитает ИИ на пятом этапе, чтобы переводить лиды самостоятельно.
          Автосообщение уходит клиенту при входе в стадию, если окно ответа открыто.
        </div>
        <Async state={stages} skeleton={<Skeleton height={220} />}>
          {(list) => (
            <StageList
              agentId={agent.id}
              list={list}
              readOnly={readOnly}
              onChanged={stages.reload}
            />
          )}
        </Async>
      </Card>

      <Card>
        <CardHead title="Поля лида" />
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 14 }}>
          Появляются в карточке рядом с перепиской. Подсказку видит только ИИ.
        </div>
        <Async state={fields} skeleton={<Skeleton height={140} />}>
          {(list) => (
            <FieldList
              agentId={agent.id}
              list={list}
              readOnly={readOnly}
              onChanged={fields.reload}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}

function StageList({
  agentId,
  list,
  readOnly,
  onChanged,
}: {
  agentId: string;
  list: Stage[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [moving, setMoving] = useState(false);

  /**
   * Runs one mutation and says whether it worked.
   *
   * The list is re-read either way. On a refusal the server has already contradicted what
   * is on screen — a reorder it rejected, a stage it would not delete — and leaving those
   * rows up would have the owner reading a funnel the server never agreed to.
   */
  async function run(action: () => Promise<unknown>, ok?: string): Promise<boolean> {
    try {
      await action();
      if (ok) toast.ok(ok);
      return true;
    } catch (error) {
      toast.fail(error);
      return false;
    } finally {
      onChanged();
    }
  }

  /** The order is sent whole: the server accepts nothing but the complete list. */
  async function move(index: number, delta: number) {
    // `list` only changes once the answer comes back, so a second click before then would
    // recompute the same order from the same rows and quietly undo itself.
    if (moving) return;
    const next = [...list];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);

    setMoving(true);
    try {
      await run(() => api.reorderStages(agentId, next.map((stage) => stage.id)));
    } finally {
      setMoving(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const added = await run(
      () => api.createStage(agentId, { name, color: '#4b8ef0', kind: 'active' }),
      'Стадия добавлена',
    );
    // Kept on a refusal: the name is what was typed, and retyping it is the last thing
    // anyone wants to do after being told why it was not accepted.
    if (added) setName('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.map((stage, index) => (
        <div key={stage.id} className="sunken-box" style={{ padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: stage.color,
                flex: '0 0 auto',
              }}
            />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{stage.name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {KINDS.find((kind) => kind.id === stage.kind)?.label}
            </span>
            {stage.autoMessage && (
              <span title="У стадии есть автосообщение" style={{ fontSize: 11 }}>
                ✉
              </span>
            )}
            {!readOnly && (
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={moving || index === 0}
                  aria-label={`Поднять стадию «${stage.name}» выше`}
                  title="Поднять выше"
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  disabled={moving || index === list.length - 1}
                  aria-label={`Опустить стадию «${stage.name}» ниже`}
                  title="Опустить ниже"
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 11.5 }}
                  onClick={() => setOpen(open === stage.id ? null : stage.id)}
                >
                  {open === stage.id ? 'Свернуть' : 'Изменить'}
                </button>
              </div>
            )}
          </div>

          {open === stage.id && (
            <StageForm
              agentId={agentId}
              stage={stage}
              onDone={() => {
                setOpen(null);
                onChanged();
              }}
              // Closed only when the stage is really gone. Both refusals here — «это
              // стадия продажи» and «в стадии N диалогов» — name the thing the owner has
              // to fix, and it is fixed in the form that collapsing would take away.
              onDelete={async () => {
                const deleted = await run(
                  () => api.deleteStage(agentId, stage.id),
                  'Стадия удалена',
                );
                if (deleted) setOpen(null);
              }}
            />
          )}
        </div>
      ))}

      {!readOnly ? (
        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            style={{ ...control, flex: 1 }}
            value={name}
            placeholder="Новая стадия"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn-sm" disabled={!name.trim()}>
            Добавить
          </button>
        </form>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          Воронку меняет владелец компании.
        </div>
      )}
    </div>
  );
}

function StageForm({
  agentId,
  stage,
  onDone,
  onDelete,
}: {
  agentId: string;
  stage: Stage;
  onDone: () => void;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [kind, setKind] = useState(stage.kind);
  const [description, setDescription] = useState(stage.description);
  const [autoMessage, setAutoMessage] = useState(stage.autoMessage ?? '');
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateStage(agentId, stage.id, { name, color, kind, description, autoMessage });
      toast.ok('Сохранено');
      onDone();
    } catch (error) {
      // The server refuses with "the funnel needs a sale stage" or "the stage still holds
      // conversations". It is written for a human, and showing it verbatim is better than
      // rewording it here.
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...control, flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          style={{ ...control, width: 46, padding: 3 }}
        />
        <select
          style={control}
          value={kind}
          onChange={(e) => setKind(e.target.value as Stage['kind'])}
        >
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        style={{ ...control, minHeight: 54, resize: 'vertical' }}
        value={description}
        placeholder="Когда лид попадает в эту стадию — для ИИ"
        onChange={(e) => setDescription(e.target.value)}
      />

      <textarea
        style={{ ...control, minHeight: 54, resize: 'vertical' }}
        value={autoMessage}
        placeholder="Автосообщение при входе. {{name}} подставит имя клиента"
        onChange={(e) => setAutoMessage(e.target.value)}
      />

      <div style={{ display: 'flex', gap: 8 }}>
        {/* An empty name is refused by the server as the generic «Не удалось разобрать
            стадию», which does not say which field is wrong. Held back here instead. */}
        <button type="submit" className="btn-sm" disabled={saving || !name.trim()}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button
          type="button"
          className="btn-link"
          style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--danger)' }}
          onClick={onDelete}
        >
          Удалить стадию
        </button>
      </div>
    </form>
  );
}

function FieldList({
  agentId,
  list,
  readOnly,
  onChanged,
}: {
  agentId: string;
  list: LeadField[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LeadField['kind']>('text');
  const [hint, setHint] = useState('');

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await api.createLeadField(agentId, { name, kind, hint });
      setName('');
      setHint('');
      onChanged();
    } catch (error) {
      toast.fail(error);
    }
  }

  async function remove(field: LeadField) {
    // Asked, not just hinted at: the hover title below says the same thing, and a touch
    // screen never shows it. Deleting the field deletes what every lead answered for it,
    // and nothing brings those answers back.
    if (
      !window.confirm(
        `Удалить поле «${field.name}» и ответы всех лидов на него? Это нельзя отменить.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteLeadField(agentId, field.id);
      onChanged();
    } catch (error) {
      toast.fail(error);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Полей пока нет.</div>
      )}
      {list.map((field) => (
        <div
          key={field.id}
          className="sunken-box"
          style={{ padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 9 }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{field.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {FIELD_KINDS.find((item) => item.id === field.kind)?.label}
          </span>
          {field.hint && (
            <span className="ellipsis" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {field.hint}
            </span>
          )}
          {!readOnly && (
            <button
              type="button"
              className="btn-link"
              style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--danger)' }}
              title="Удалить поле и все ответы на него"
              onClick={() => remove(field)}
            >
              Удалить
            </button>
          )}
        </div>
      ))}

      {readOnly ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          Поля лида меняет владелец компании.
        </div>
      ) : (
        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            style={{ ...control, flex: 1 }}
            value={name}
            placeholder="Название"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            style={{ ...control, flex: 1 }}
            value={hint}
            placeholder="Подсказка для ИИ"
            onChange={(e) => setHint(e.target.value)}
          />
          <select
            style={control}
            value={kind}
            onChange={(e) => setKind(e.target.value as LeadField['kind'])}
          >
            {FIELD_KINDS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-sm" disabled={!name.trim()}>
            Добавить
          </button>
        </form>
      )}
    </div>
  );
}
