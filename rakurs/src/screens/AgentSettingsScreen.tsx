import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { useAgent } from '@/store/agent';

const field: CSSProperties = {
  width: '100%',
  maxWidth: 460,
  padding: '10px 12px',
  marginTop: 6,
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  outline: 'none',
};

const label: CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)' };

/** Timezones the cabinet offers. More arrive when a client needs one. */
const ZONES = ['Asia/Almaty', 'Asia/Tashkent', 'Europe/Moscow', 'UTC'];

export function AgentSettingsScreen() {
  const { agent, role, replace } = useAgent();
  const toast = useToast();

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [timezone, setTimezone] = useState(agent.timezone);
  const [saving, setSaving] = useState(false);

  const readOnly = role !== 'owner';
  const dirty =
    name !== agent.name || description !== agent.description || timezone !== agent.timezone;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return toast.fail(undefined, 'Название агента не может быть пустым');

    setSaving(true);
    try {
      replace(await api.updateAgent(agent.id, { name, description, timezone }));
      toast.ok('Сохранено');
    } catch (error) {
      // The saved values stay on screen: retyping them after a failed save is the
      // last thing anyone wants to do.
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={label}>Название</div>
          <input
            style={field}
            value={name}
            disabled={readOnly}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <div style={label}>Описание</div>
          <input
            style={field}
            value={description}
            disabled={readOnly}
            placeholder="Чем занимается этот агент"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <div style={label}>Часовой пояс</div>
          <select
            style={field}
            value={timezone}
            disabled={readOnly}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {/* An agent moved to a zone the list does not offer must still show its own. */}
            {(ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES]).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>

        {readOnly ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Настройки агента меняет владелец компании.
          </div>
        ) : (
          <div>
            <button type="submit" className="btn" disabled={!dirty || saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
