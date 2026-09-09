import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card, CardHead, Toggle } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { RULE_CATEGORIES, ruleCategoryLabel } from '@/lib/rule-categories';
import type { AgentRule, RuleCategory } from '@/types';

/**
 * Every rule the agent follows, grouped under the headings the prompt itself reads them in.
 *
 * Grouping walks `rules` once and starts a new group whenever the category changes from the
 * row before it — never a fixed list of the four categories filtered four times. `GET /rules`
 * already answers with same-category rows contiguous and in the model's own order (see
 * `rules.ts`'s `RULE_CATEGORY_ORDER`), so this reproduces exactly that order without a second,
 * client-side opinion of what it is.
 */
function groupByCategory(rules: AgentRule[]): { category: RuleCategory; rules: AgentRule[] }[] {
  const groups: { category: RuleCategory; rules: AgentRule[] }[] = [];
  for (const rule of rules) {
    const last = groups[groups.length - 1];
    if (last && last.category === rule.category) last.rules.push(rule);
    else groups.push({ category: rule.category, rules: [rule] });
  }
  return groups;
}

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
};

const DISCARD_PROMPT = 'Уйти без сохранения? Несохранённые правки правила будут потеряны.';

export function RuleList({
  agentId,
  rules,
  onChanged,
}: {
  agentId: string;
  rules: AgentRule[];
  onChanged: (rules: AgentRule[]) => void;
}) {
  const toast = useToast();

  // Which rule's text is open in the inline editor, and what has been typed into it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newCategory, setNewCategory] = useState<RuleCategory>('business');
  const [newText, setNewText] = useState('');
  const [addingRule, setAddingRule] = useState(false);

  const [dragId, setDragId] = useState<string | null>(null);

  const editingRule = rules.find((rule) => rule.id === editingId) ?? null;
  const dirty = editingRule !== null && draft !== editingRule.text;

  /** `false` means a dirty draft vetoed the switch and asked the owner first — the same
   * guard `KnowledgeScreen` runs before it lets a click discard an unsaved note. */
  function confirmDiscard(): boolean {
    return !dirty || window.confirm(DISCARD_PROMPT);
  }

  async function refresh() {
    onChanged(await api.listRules(agentId));
  }

  function startEdit(rule: AgentRule) {
    if (editingId === rule.id) return;
    if (!confirmDiscard()) return;
    setCreating(false);
    setEditingId(rule.id);
    setDraft(rule.text);
  }

  function cancelEdit() {
    // An explicit «Отмена» already answers the question the guard exists to ask.
    setEditingId(null);
  }

  async function saveEdit() {
    if (!editingRule || saving || draft.trim() === '') return;
    setSaving(true);
    try {
      await api.updateRule(agentId, editingRule.id, { text: draft.trim() });
      toast.ok('Правило сохранено');
      setEditingId(null);
      await refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(rule: AgentRule) {
    try {
      await api.updateRule(agentId, rule.id, { enabled: !rule.enabled });
      await refresh();
    } catch (error) {
      toast.fail(error);
    }
  }

  async function remove(rule: AgentRule) {
    if (!window.confirm(`Удалить правило «${rule.text}»? Это нельзя отменить.`)) return;
    try {
      await api.deleteRule(agentId, rule.id);
      toast.ok('Правило удалено');
      if (editingId === rule.id) setEditingId(null);
      await refresh();
    } catch (error) {
      toast.fail(error);
    }
  }

  function openCreate() {
    if (!confirmDiscard()) return;
    setEditingId(null);
    setNewText('');
    setCreating(true);
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (addingRule || newText.trim() === '') return;
    setAddingRule(true);
    try {
      await api.createRule(agentId, { category: newCategory, text: newText.trim() });
      toast.ok('Правило добавлено');
      setCreating(false);
      setNewText('');
      await refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setAddingRule(false);
    }
  }

  // Drag-and-drop is native: no library, and a category holds at most a few dozen rows.
  // Cross-category drops are ignored — changing what a rule is about is what the edit form
  // and the coach are for, not a drag.
  function onDrop(target: AgentRule) {
    const draggedId = dragId;
    setDragId(null);
    if (!draggedId || draggedId === target.id) return;
    const dragged = rules.find((rule) => rule.id === draggedId);
    if (!dragged || dragged.category !== target.category) return;
    api
      .updateRule(agentId, dragged.id, { position: target.position })
      .then(refresh)
      .catch((error) => toast.fail(error));
  }

  const groups = groupByCategory(rules);

  return (
    <Card>
      <CardHead
        title="Правила агента"
        right={
          <button type="button" className="btn-sm" onClick={openCreate}>
            + Добавить правило
          </button>
        }
      />

      {creating && (
        <form
          onSubmit={submitCreate}
          className="sunken-box"
          style={{ padding: 12, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <select
            style={control}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as RuleCategory)}
          >
            {RULE_CATEGORIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <textarea
            style={{ ...control, minHeight: 60 }}
            value={newText}
            placeholder="Например: всегда спрашиваем город доставки."
            autoFocus
            onChange={(e) => setNewText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn-sm" disabled={addingRule || newText.trim() === ''}>
              {addingRule ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={() => setCreating(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {rules.length === 0 && !creating ? (
        <EmptyState>Правил пока нет. Добавьте своё или обучите агента в чате слева.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.map((group) => (
            <div key={`${group.category}-${group.rules[0]!.id}`}>
              <div style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--text-dim)', marginBottom: 8 }}>
                {ruleCategoryLabel(group.category)}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {group.rules.map((rule) => (
                  <div
                    key={rule.id}
                    draggable={editingId !== rule.id}
                    onDragStart={() => setDragId(rule.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDrop(rule)}
                    className="sunken-box"
                    style={{
                      padding: '9px 10px',
                      display: 'flex',
                      alignItems: editingId === rule.id ? 'stretch' : 'flex-start',
                      gap: 9,
                    }}
                  >
                    <span
                      title="Перетащите, чтобы изменить порядок"
                      style={{ cursor: 'grab', color: 'var(--text-dim)', paddingTop: 3, flex: '0 0 auto' }}
                    >
                      ⠿
                    </span>

                    <button
                      type="button"
                      className="btn-quiet"
                      aria-pressed={rule.enabled}
                      style={{ flex: '0 0 auto', marginTop: 1 }}
                      onClick={() => toggleEnabled(rule)}
                    >
                      <Toggle on={rule.enabled} />
                    </button>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      {editingId === rule.id ? (
                        <textarea
                          style={{ ...control, minHeight: 52 }}
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                        />
                      ) : (
                        <div
                          style={{
                            fontSize: 12.5,
                            lineHeight: 1.5,
                            color: rule.enabled ? 'var(--text)' : 'var(--text-dim)',
                          }}
                        >
                          {rule.text}
                        </div>
                      )}
                      {rule.warning && (
                        <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>{rule.warning}</div>
                      )}
                      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
                        {rule.origin === 'coach' ? 'из чата' : 'руками'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                      {editingId === rule.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-sm"
                            disabled={saving || draft.trim() === ''}
                            onClick={saveEdit}
                          >
                            {saving ? '…' : 'Сохранить'}
                          </button>
                          <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={cancelEdit}>
                            Отмена
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={() => startEdit(rule)}>
                            Изменить
                          </button>
                          <button
                            type="button"
                            className="btn-link"
                            style={{ fontSize: 11.5, color: 'var(--danger)' }}
                            onClick={() => remove(rule)}
                          >
                            Удалить
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
