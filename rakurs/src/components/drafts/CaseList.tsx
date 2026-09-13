import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { ruPlural } from '@/components/drafts/cost';
import { CheckBox, Toggle } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import type { SuggestedCase, TestCase } from '@/types';

const messagesWord = (n: number) => ruPlural(n, 'сообщение', 'сообщения', 'сообщений');

/**
 * The case set a draft is proven against — kept by hand, pulled out of a real dialog
 * (`DialogsScreen`'s own «В проверки»), or suggested here and saved one at a time.
 *
 * One list serves two jobs at once, deliberately: the checkbox on the left is what the run
 * button reads (`selected`, owned by `DraftScreen` so the cost sentence above the button can
 * read it too), and «Изменить» / «Удалить» / the enable toggle are the whole of what the
 * brief calls the «Проверки» tab — there is no second list, only a second place this same one
 * is shown without the run controls crowding it.
 */

const control: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.5,
  outline: 'none',
  resize: 'vertical',
};

export const ORIGIN_LABEL: Record<TestCase['origin'], string> = {
  manual: 'руками',
  dialog: 'из диалога',
  generated: 'предложен моделью',
  correction: 'обязательный случай исправления',
  suggested: 'придумано',
};

/** Not a real case id — every id is a uuid the server minted. Marks the inline slot as "a
 * blank case, not yet saved" — the same sentinel `KnowledgeTab` and `RuleList` each keep
 * their own copy of, for the same reason: one slot for both a create draft and an edit draft. */
const NEW = 'new';

const linesToMessages = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function CaseList({
  agentId,
  draftId,
  cases,
  onChanged,
  selected,
  onSelectedChange,
  selectionDisabled = false,
}: {
  agentId: string;
  draftId: string;
  cases: TestCase[];
  /** "Something changed, reload" — not handed the fresh list itself, so a create, an edit and
   * a delete all funnel through the one `useApi` reload the parent already owns instead of
   * each fetching its own copy and risking the two disagreeing. */
  onChanged: () => void;
  /** Case ids the next run would cover — lifted to `DraftScreen` so the cost sentence and the
   * run button read the same set this list's checkboxes write. */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Locks the checkboxes while the autopilot owns the case set. */
  selectionDisabled?: boolean;
}) {
  const toast = useToast();

  const [slot, setSlot] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [messagesText, setMessagesText] = useState('');
  const [expectation, setExpectation] = useState('');
  const [saving, setSaving] = useState(false);

  const [suggested, setSuggested] = useState<SuggestedCase[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [addingSuggested, setAddingSuggested] = useState<number | null>(null);

  const creating = slot === NEW;
  const editingId = creating ? null : slot;

  function toggleSelected(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  }


  function openCreate() {
    setSlot(NEW);
    setTitle('');
    setMessagesText('');
    setExpectation('');
  }

  function startEdit(kase: TestCase) {
    setSlot(kase.id);
    setTitle(kase.title);
    setMessagesText(kase.messages.join('\n'));
    setExpectation(kase.expectation ?? '');
  }

  function closeSlot() {
    setSlot(null);
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    const messages = linesToMessages(messagesText);
    if (saving || title.trim() === '' || messages.length === 0) return;
    setSaving(true);
    try {
      const created = await api.createTestCase(agentId, {
        title: title.trim(),
        messages,
        expectation: expectation.trim() === '' ? null : expectation.trim(),
      });
      toast.ok('Случай добавлен');
      // A case just added is a case the owner presumably wants in the next run.
      onSelectedChange(new Set(selected).add(created.id));
      setSlot(null);
      onChanged();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(kase: TestCase) {
    const messages = linesToMessages(messagesText);
    if (saving || title.trim() === '' || messages.length === 0) return;
    setSaving(true);
    try {
      await api.updateTestCase(agentId, kase.id, {
        title: title.trim(),
        messages,
        expectation: expectation.trim() === '' ? null : expectation.trim(),
      });
      toast.ok('Случай сохранён');
      setSlot(null);
      onChanged();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(kase: TestCase) {
    try {
      await api.updateTestCase(agentId, kase.id, { enabled: !kase.enabled });
      onChanged();
    } catch (error) {
      toast.fail(error);
    }
  }

  async function remove(kase: TestCase) {
    if (!window.confirm(`Удалить случай «${kase.title}»? Это нельзя отменить.`)) return;
    try {
      await api.deleteTestCase(agentId, kase.id);
      const next = new Set(selected);
      next.delete(kase.id);
      onSelectedChange(next);
      if (slot === kase.id) setSlot(null);
      toast.ok('Случай удалён');
      onChanged();
    } catch (error) {
      toast.fail(error);
    }
  }

  async function suggestMore() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const { cases: proposed } = await api.suggestCases(agentId, draftId);
      // Added, not replaced: asking twice should not throw away what the first answer
      // offered and the owner has not yet decided about.
      setSuggested((prev) => [...prev, ...proposed]);
    } catch (error) {
      toast.fail(error);
    } finally {
      setSuggesting(false);
    }
  }

  async function saveSuggested(index: number) {
    const item = suggested[index];
    if (!item || addingSuggested !== null) return;
    setAddingSuggested(index);
    try {
      const created = await api.createTestCase(agentId, { title: item.title, messages: item.messages });
      onSelectedChange(new Set(selected).add(created.id));
      setSuggested((prev) => prev.filter((_, i) => i !== index));
      toast.ok('Случай добавлен');
      onChanged();
    } catch (error) {
      toast.fail(error);
    } finally {
      setAddingSuggested(null);
    }
  }

  function dismissSuggested(index: number) {
    setSuggested((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="btn-sm" onClick={openCreate}>
          + Добавить случай
        </button>
        <button type="button" className="btn-sm" disabled={suggesting} onClick={suggestMore}>
          {suggesting ? 'Придумываем…' : 'Придумать проверки'}
        </button>
      </div>

      {creating && (
        <CaseForm
          title={title}
          messagesText={messagesText}
          expectation={expectation}
          saving={saving}
          onTitle={setTitle}
          onMessages={setMessagesText}
          onExpectation={setExpectation}
          onSubmit={submitCreate}
          onCancel={closeSlot}
        />
      )}

      {cases.length === 0 && suggested.length === 0 && !creating ? (
        <EmptyState>
          Случаев пока нет. Добавьте свой, занесите его из диалога кнопкой «В проверки» или
          нажмите «Придумать проверки».
        </EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {suggested.map((item, i) => (
            <div
              key={`suggested-${i}`}
              className="sunken-box"
              style={{ padding: '9px 10px', display: 'flex', alignItems: 'flex-start', gap: 9 }}
            >
              <CheckBox on={false} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{item.title}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
                  предложено моделью — не сохранён
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 11.5 }}
                  disabled={addingSuggested !== null}
                  onClick={() => void saveSuggested(i)}
                >
                  {addingSuggested === i ? 'Добавляем…' : 'Добавить'}
                </button>
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 11.5, color: 'var(--text-dim)' }}
                  onClick={() => dismissSuggested(i)}
                >
                  Скрыть
                </button>
              </div>
            </div>
          ))}

          {cases.map((kase) =>
            editingId === kase.id ? (
              <div key={kase.id} className="sunken-box" style={{ padding: '9px 10px' }}>
                <CaseForm
                  title={title}
                  messagesText={messagesText}
                  expectation={expectation}
                  saving={saving}
                  onTitle={setTitle}
                  onMessages={setMessagesText}
                  onExpectation={setExpectation}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveEdit(kase);
                  }}
                  onCancel={closeSlot}
                />
              </div>
            ) : (
              <div
                key={kase.id}
                className="sunken-box"
                style={{ padding: '9px 10px', display: 'flex', alignItems: 'flex-start', gap: 9 }}
              >
                <button
                  type="button"
                  className="btn-quiet"
                  aria-pressed={selected.has(kase.id)}
                  disabled={selectionDisabled}
                  style={{ marginTop: 1 }}
                  onClick={() => toggleSelected(kase.id)}
                >
                  <CheckBox on={selected.has(kase.id)} />
                </button>

                <button
                  type="button"
                  className="btn-quiet"
                  aria-pressed={kase.enabled}
                  style={{ marginTop: 1 }}
                  onClick={() => void toggleEnabled(kase)}
                >
                  <Toggle on={kase.enabled} />
                </button>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: kase.enabled ? 'var(--text)' : 'var(--text-dim)' }}>
                    {kase.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
                    {ORIGIN_LABEL[kase.origin]} · {kase.messages.length} {messagesWord(kase.messages.length)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                  <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={() => startEdit(kase)}>
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 11.5, color: 'var(--danger)' }}
                    onClick={() => void remove(kase)}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function CaseForm({
  title,
  messagesText,
  expectation,
  saving,
  onTitle,
  onMessages,
  onExpectation,
  onSubmit,
  onCancel,
}: {
  title: string;
  messagesText: string;
  expectation: string;
  saving: boolean;
  onTitle: (v: string) => void;
  onMessages: (v: string) => void;
  onExpectation: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const messages = linesToMessages(messagesText);
  return (
    <form
      onSubmit={onSubmit}
      className="sunken-box"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <input
        style={control}
        value={title}
        placeholder="Название случая"
        onChange={(e) => onTitle(e.target.value)}
      />
      <textarea
        style={{ ...control, minHeight: 64 }}
        value={messagesText}
        placeholder={'Сообщения клиента, по одному на строку —\nСколько стоит доставка?\nА в область?'}
        onChange={(e) => onMessages(e.target.value)}
      />
      <textarea
        style={{ ...control, minHeight: 44 }}
        value={expectation}
        placeholder="Чего ждём от ответа — необязательно, для себя"
        onChange={(e) => onExpectation(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="submit" className="btn-sm" disabled={saving || title.trim() === '' || messages.length === 0}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
