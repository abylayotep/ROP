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

const DISCARD_PROMPT = 'Уйти без сохранения? Несохранённый текст правила будет потерян.';

/** Not a real rule id — every rule id is a uuid the server minted, and this string never
 * collides with one. Marks the inline slot as "a blank rule, not yet saved". Mirrors
 * `KnowledgeScreen`'s own `NEW` sentinel, for the same reason: a create draft and an edit
 * draft are the same kind of unsaved text, so they share one slot and one dirty guard
 * instead of two states that can't see each other. */
const NEW = 'new';

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

  // The one inline slot open at a time: a rule id being edited, `NEW` for the create form,
  // or `null` when nothing is open. Folding "which rule" and "am I creating" into one piece
  // of state is what lets a single guard see every draft — two independent booleans (one for
  // the inline editor, one for the create form) would each answer "is *my* draft dirty" and
  // never "is there a draft at all", so switching from one to the other would discard the
  // other's text with no prompt.
  const [slot, setSlot] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // The edit form's own category pick — separate from `newCategory` below, which belongs
  // to the create form. An edit starts from the rule's current category (`startEdit` sets
  // it), and changing it is what lets «Изменить» move a rule between categories: the same
  // move a drag can only do within one.
  const [editCategory, setEditCategory] = useState<RuleCategory>('business');
  const [saving, setSaving] = useState(false);

  const [newCategory, setNewCategory] = useState<RuleCategory>('business');
  const [addingRule, setAddingRule] = useState(false);

  const [dragId, setDragId] = useState<string | null>(null);

  const creating = slot === NEW;
  const editingId = creating ? null : slot;
  const editingRule = editingId !== null ? rules.find((rule) => rule.id === editingId) ?? null : null;
  // A changed category with untouched text is still unsaved work — «Сохранить» would move
  // the rule, so leaving without it is exactly what the discard guard exists to catch.
  const dirty = creating
    ? draft.trim() !== ''
    : editingRule !== null && (draft !== editingRule.text || editCategory !== editingRule.category);

  /** `false` means a dirty draft vetoed the switch and asked the owner first — the same
   * guard `KnowledgeScreen` runs before it lets a click discard an unsaved note. Covers both
   * directions: leaving an in-progress create for an edit, and leaving an in-progress edit
   * for the create form, since both drafts now live in the one `slot`/`draft` pair above. */
  function confirmDiscard(): boolean {
    return !dirty || window.confirm(DISCARD_PROMPT);
  }

  async function refresh() {
    onChanged(await api.listRules(agentId));
  }

  function startEdit(rule: AgentRule) {
    if (slot === rule.id) return;
    if (!confirmDiscard()) return;
    setSlot(rule.id);
    setDraft(rule.text);
    setEditCategory(rule.category);
  }

  function closeSlot() {
    // An explicit «Отмена» already answers the question the guard exists to ask.
    setSlot(null);
  }

  async function saveEdit() {
    if (!editingRule || saving || draft.trim() === '') return;
    setSaving(true);
    try {
      // `category` goes along even when it hasn't changed — the server no-ops a same-
      // category PATCH (see `rules.ts`'s `movingCategory` check), so there's no need to
      // special-case "did the owner actually touch the dropdown" here.
      await api.updateRule(agentId, editingRule.id, { text: draft.trim(), category: editCategory });
      toast.ok('Правило сохранено');
      setSlot(null);
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
      if (slot === rule.id) setSlot(null);
      await refresh();
    } catch (error) {
      toast.fail(error);
    }
  }

  function openCreate() {
    if (creating) return;
    if (!confirmDiscard()) return;
    setDraft('');
    setNewCategory('business');
    setSlot(NEW);
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (addingRule || draft.trim() === '') return;
    setAddingRule(true);
    try {
      await api.createRule(agentId, { category: newCategory, text: draft.trim() });
      toast.ok('Правило добавлено');
      setSlot(null);
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
            value={draft}
            placeholder="Например: всегда спрашиваем город доставки."
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn-sm" disabled={addingRule || draft.trim() === ''}>
              {addingRule ? 'Сохраняем…' : 'Сохранить'}
            </button>
            <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={closeSlot}>
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
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <select
                            style={control}
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value as RuleCategory)}
                          >
                            {RULE_CATEGORIES.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                          <textarea
                            style={{ ...control, minHeight: 52 }}
                            value={draft}
                            autoFocus
                            onChange={(e) => setDraft(e.target.value)}
                          />
                        </div>
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
                          <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={closeSlot}>
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
