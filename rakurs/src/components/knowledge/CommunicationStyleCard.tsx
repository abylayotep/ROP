import { useEffect, useState } from 'react';
import * as api from '@/api';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { CommunicationStyle, CommunicationStyleSettings } from '@/types';

const STYLES: ReadonlyArray<{ id: CommunicationStyle; label: string; hint: string }> = [
  { id: 'warm', label: 'Живой и тёплый', hint: 'На «вы», коротко, с уместными эмодзи' },
  { id: 'calm', label: 'Спокойный', hint: 'Сдержанно, точно и без лишней эмоциональности' },
  { id: 'friendly', label: 'Дружеский', hint: 'Неформально, открыто и по делу' },
];

export const communicationStyleLabel = (preset: CommunicationStyle): string =>
  STYLES.find((style) => style.id === preset)?.label ?? preset;

type StyleUpdate = (
  agentId: string,
  preset: CommunicationStyle,
) => Promise<CommunicationStyleSettings>;

export const saveCommunicationStyle = (
  agentId: string,
  preset: CommunicationStyle,
  update: StyleUpdate = api.updateCommunicationStyle,
) => update(agentId, preset);

export function CommunicationStyleCard({
  agentId,
  readOnly = false,
}: {
  agentId: string;
  readOnly?: boolean;
}) {
  const source = useApi((signal) => api.getCommunicationStyle(agentId, signal), [agentId]);
  const [selected, setSelected] = useState<CommunicationStyle>(source.data?.preset ?? 'warm');
  const [saved, setSaved] = useState<CommunicationStyleSettings | undefined>(source.data);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!source.data) return;
    setSelected(source.data.preset);
    setSaved(source.data);
  }, [source.data]);

  async function save() {
    if (readOnly || saving || selected === saved?.preset) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const next = await saveCommunicationStyle(agentId, selected);
      setSaved(next);
      setSelected(next.preset);
      setSaveMessage({ kind: 'ok', text: 'Стиль общения сохранён' });
    } catch (error) {
      setSaveMessage({ kind: 'error', text: api.humanError(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="communication-style" aria-labelledby="communication-style-title">
      <div className="knowledge-panel-head">
        <div>
          <p className="knowledge-kicker">Будущие ответы</p>
          <h2 id="communication-style-title">Стиль общения</h2>
        </div>
      </div>

      {source.data === undefined && source.error === undefined && (
        <div className="communication-style__loading" role="status" aria-label="Загружаем стиль общения">
          <Skeleton height={48} /><Skeleton height={48} /><Skeleton height={48} />
        </div>
      )}
      {source.data === undefined && source.error !== undefined && (
        <ErrorState error={source.error} onRetry={source.reload} compact />
      )}
      {saved && (
        <>
          <fieldset className="communication-style__options" disabled={readOnly || saving}>
            <legend className="sr-only">Выберите стиль общения</legend>
            {STYLES.map((style) => (
              <label key={style.id} className="communication-style__option">
                <input
                  type="radio"
                  name={`communication-style-${agentId}`}
                  value={style.id}
                  checked={selected === style.id}
                  onChange={() => setSelected(style.id)}
                />
                <span>
                  <b>{style.label}</b>
                  <small>{style.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <blockquote className="communication-style__preview" aria-live="polite">
            <span>Пример ответа</span>
            <p>{saved.preview}</p>
          </blockquote>
          <p className="communication-style__note">
            Меняет только будущие ответы и новые генерации. Готовые черновики не переписываются.
          </p>
          {!readOnly && (
            <button
              type="button"
              className="btn-accent communication-style__save"
              disabled={saving || selected === saved.preset}
              onClick={() => void save()}
            >
              {saving ? 'Сохраняем…' : 'Сохранить стиль'}
            </button>
          )}
          {saveMessage && (
            <p className={`communication-style__message communication-style__message--${saveMessage.kind}`} role={saveMessage.kind === 'error' ? 'alert' : 'status'}>
              {saveMessage.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
