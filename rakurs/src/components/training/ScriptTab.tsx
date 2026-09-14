import { Fragment, useEffect, useMemo, useState } from 'react';
import * as api from '@/api';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import type { LeadField, Product, SalesScript, ScriptStep, ScriptStepInput, Stage } from '@/types';
import './script-tab.css';

/** Mirrors `server/src/lib/ai/sales-script.ts`: checked here too, so a wrong edit fails before the save. */
export const SCRIPT_STEP_LIMIT = 40;
export const STEP_PHOTOS = 4;
export const STEP_FIELDS = 10;
const TITLE_MAX = 80;
const CONDITION_MAX = 200;
const INSTRUCTIONS_MAX = 2000;
const NOTE_MAX = 200;

/**
 * The script as the editor holds it: the save body's steps, always in chain order — each
 * main-chain step followed by its own branches. Every helper below keeps that order, so the
 * list is at once what the screen draws, what the numbers are counted from and what is saved.
 */
export type DraftStep = ScriptStepInput;

let counter = 0;
/** A client id for a new step; the server replaces it with a uuid on save. */
export const newStepId = () => `tmp-${Date.now().toString(36)}-${(counter += 1)}`;

export const blankStep = (over: Partial<DraftStep> = {}): DraftStep => ({
  id: newStepId(), parentId: null, title: '', condition: '', instructions: '', stageId: null,
  photoIds: [], fieldIds: [], handoff: false, handoffNote: '', waitPayment: false, ...over,
});

/** The saved steps, without the positions the list order already carries. */
export const draftOf = (steps: ScriptStep[]): DraftStep[] =>
  steps.map(({ position: _position, ...step }) => step);

/** A main-chain step and its branches, as one slice of the list. */
function blockEnd(steps: DraftStep[], rootIndex: number): number {
  let end = rootIndex + 1;
  while (end < steps.length && steps[end]!.parentId !== null) end += 1;
  return end;
}

/** A new main-chain step after `afterId`'s block, at the start for `'start'`, at the end for null. */
export function addStep(steps: DraftStep[], afterId: string | null | 'start', step = blankStep()): DraftStep[] {
  const root = { ...step, parentId: null, condition: '' };
  if (afterId === 'start') return [root, ...steps];
  const at = afterId === null ? -1 : steps.findIndex((item) => item.id === afterId);
  if (at === -1) return [...steps, root];
  const end = blockEnd(steps, at);
  return [...steps.slice(0, end), root, ...steps.slice(end)];
}

/** A new branch under a main-chain step, after its existing branches. */
export function addBranch(steps: DraftStep[], parentId: string, step = blankStep()): DraftStep[] {
  const at = steps.findIndex((item) => item.id === parentId && item.parentId === null);
  if (at === -1) return steps;
  const end = blockEnd(steps, at);
  return [...steps.slice(0, end), { ...step, parentId }, ...steps.slice(end)];
}

/** Moves a step one place among its siblings; a main-chain step takes its branches along. */
export function moveStep(steps: DraftStep[], id: string, by: -1 | 1): DraftStep[] {
  const at = steps.findIndex((item) => item.id === id);
  if (at === -1) return steps;
  const step = steps[at]!;
  if (step.parentId !== null) {
    const other = at + by;
    if (other < 0 || other >= steps.length || steps[other]!.parentId !== step.parentId) return steps;
    const next = [...steps];
    [next[at], next[other]] = [next[other]!, next[at]!];
    return next;
  }
  const roots = steps.map((item, index) => (item.parentId === null ? index : -1)).filter((index) => index !== -1);
  const place = roots.indexOf(at);
  const neighbour = roots[place + by];
  if (neighbour === undefined) return steps;
  const [first, second] = by === -1 ? [neighbour, at] : [at, neighbour];
  const firstEnd = blockEnd(steps, first);
  const secondEnd = blockEnd(steps, second);
  return [...steps.slice(0, first), ...steps.slice(second, secondEnd), ...steps.slice(firstEnd, second),
    ...steps.slice(first, firstEnd), ...steps.slice(secondEnd)];
}

/** Removes a step; a main-chain step goes with its branches. */
export const removeStep = (steps: DraftStep[], id: string): DraftStep[] =>
  steps.filter((item) => item.id !== id && item.parentId !== id);

export const updateStep = (steps: DraftStep[], id: string, patch: Partial<DraftStep>): DraftStep[] =>
  steps.map((item) => (item.id === id ? { ...item, ...patch } : item));

/** `1`, `2`, `2.а` — the same numbers the agent reads in its prompt. */
export function stepNumbers(steps: DraftStep[]): Map<string, string> {
  const letters = 'абвгдежзиклмнопрстуфхцчшэюя';
  const numbers = new Map<string, string>();
  let root = 0;
  let branch = 0;
  for (const step of steps) {
    if (step.parentId === null) {
      root += 1;
      branch = 0;
      numbers.set(step.id, String(root));
    } else {
      numbers.set(step.id, `${root}.${letters[branch] ?? String(branch + 1)}`);
      branch += 1;
    }
  }
  return numbers;
}

/** The body the server takes, or the first thing wrong with the draft. */
export function saveRequest(steps: DraftStep[]):
  { ok: true; steps: DraftStep[] } | { ok: false; message: string; stepId?: string } {
  if (steps.length > SCRIPT_STEP_LIMIT) return { ok: false, message: `В скрипте не больше ${SCRIPT_STEP_LIMIT} шагов` };
  const numbers = stepNumbers(steps);
  for (const step of steps) {
    if (step.title.trim() === '') return { ok: false, message: `Укажите название шага ${numbers.get(step.id)}`, stepId: step.id };
  }
  return {
    ok: true,
    steps: steps.map((step) => ({
      ...step,
      title: step.title.trim(),
      condition: step.parentId === null ? '' : step.condition.trim(),
      instructions: step.instructions.trim(),
      handoffNote: step.handoff ? step.handoffNote.trim() : '',
    })),
  };
}

/** The Sealhouse order of a sale, as a start the owner edits rather than a blank page. */
export function templateSteps(): DraftStep[] {
  return [
    blankStep({ title: 'Приветствие', instructions: 'Поздоровайся, представься менеджером компании и спроси, что клиенту интересно.' }),
    blankStep({ title: 'Выбор товара', instructions: 'Отправь фото вариантов и попроси выбрать один.' }),
    blankStep({ title: 'Размер и цена', instructions: 'Назови стандартный размер и цену выбранного варианта.' }),
    blankStep({ title: 'Адрес', instructions: 'Спроси адрес доставки.' }),
    blankStep({ title: 'Доставка', instructions: 'Объясни, как и когда доставим.' }),
    blankStep({ title: 'Оплата', instructions: 'Назови итоговую сумму и как оплатить.', waitPayment: true }),
    blankStep({ title: 'После оплаты', instructions: 'Поблагодари за оплату и отправь фото готового товара.' }),
  ];
}

const same = (a: DraftStep[], b: DraftStep[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * «Скрипт продаж»: the order a sale is talked through, step by step, which the agent follows.
 * A chain of cards on the left, the selected step on the right. Edits stay local until one
 * «Сохранить» sends the whole tree. Members see it read-only; the server enforces the same.
 */
export function ScriptTab({ agentId, owner, onDirtyChange }: {
  agentId: string;
  owner: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const query = useApi<SalesScript>((signal) => api.getSalesScript(agentId, signal), [agentId]);
  const stages = useApi<Stage[]>((signal) => api.listStages(agentId, signal), [agentId]);
  const fields = useApi<LeadField[]>((signal) => api.listLeadFields(agentId, signal), [agentId]);
  const products = useApi<Product[]>((signal) => api.listProducts(agentId, signal), [agentId]);

  const [saved, setSaved] = useState<DraftStep[] | null>(null);
  const [draft, setDraft] = useState<DraftStep[] | null>(null);
  const baseline = saved ?? (query.data ? draftOf(query.data.steps) : undefined);
  const steps = draft ?? baseline;
  const dirty = baseline !== undefined && draft !== null && !same(draft, baseline);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (steps === undefined) {
    return query.error !== undefined
      ? <ErrorState error={query.error} onRetry={query.reload} compact />
      : <Skeleton height={240} />;
  }

  return (
    <ScriptEditor
      agentId={agentId}
      owner={owner}
      steps={steps}
      dirty={dirty}
      stages={stages.data ?? []}
      fields={fields.data ?? []}
      products={products.data ?? []}
      onChange={setDraft}
      onSaved={(next) => { setSaved(next); setDraft(null); }}
    />
  );
}

export function ScriptEditor({ agentId, owner, steps, dirty, stages, fields, products, onChange, onSaved }: {
  agentId: string;
  owner: boolean;
  steps: DraftStep[];
  dirty: boolean;
  stages: Stage[];
  fields: LeadField[];
  products: Product[];
  onChange: (steps: DraftStep[]) => void;
  onSaved: (steps: DraftStep[]) => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(steps[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const numbers = useMemo(() => stepNumbers(steps), [steps]);
  const selected = steps.find((step) => step.id === selectedId) ?? null;
  const readOnly = !owner;
  const full = steps.length >= SCRIPT_STEP_LIMIT;

  const change = (next: DraftStep[], select?: string | null) => {
    setProblem(null);
    onChange(next);
    if (select !== undefined) setSelectedId(select);
  };

  const add = (afterId: string | null | 'start') => {
    const step = blankStep({ title: 'Новый шаг' });
    change(addStep(steps, afterId, step), step.id);
  };
  const branch = (parentId: string) => {
    const step = blankStep({ title: 'Новая ветка', condition: 'Если клиент…' });
    change(addBranch(steps, parentId, step), step.id);
  };
  const remove = (step: DraftStep) => {
    const branches = steps.filter((item) => item.parentId === step.id).length;
    const what = branches > 0 ? `шаг «${step.title}» вместе с ветками (${branches})` : `шаг «${step.title}»`;
    if (!window.confirm(`Удалить ${what}?`)) return;
    change(removeStep(steps, step.id), selectedId === step.id ? null : selectedId);
  };

  async function save() {
    if (readOnly || busy) return;
    const body = saveRequest(steps);
    if (!body.ok) {
      setProblem(body.message);
      if (body.stepId) setSelectedId(body.stepId);
      return;
    }
    setBusy(true);
    try {
      const at = steps.findIndex((step) => step.id === selectedId);
      const result = await api.saveSalesScript(agentId, { steps: body.steps });
      const next = draftOf(result.steps);
      onSaved(next);
      // New steps come back with server ids; the selection follows the step's place in the list.
      setSelectedId(at === -1 ? null : next[at]?.id ?? null);
      toast.ok('Скрипт сохранён');
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  const roots = steps.filter((step) => step.parentId === null);

  return (
    <div className="script-tab">
      <div className="script-tab__head">
        <p className="training-tab__intro">
          Порядок продажи, по которому агент ведёт клиента: шаг за шагом, с ветками на случай, если клиент
          сомневается или спрашивает о другом. Шаг «Ждать оплату» агент не пройдёт, пока оплату не подтвердит система.
        </p>
        {owner && steps.length > 0 && (
          <div className="script-tab__actions">
            {dirty && <span className="script-tab__dirty">Есть несохранённые изменения</span>}
            <button type="button" className="btn-accent" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        )}
      </div>
      {problem && <p className="script-tab__problem" role="alert">{problem}</p>}

      {steps.length === 0 ? (
        <div className="knowledge-inline-state script-empty">
          <p>Скрипта пока нет</p>
          {owner ? (
            <>
              <span>Без скрипта агент ведёт продажу по общему порядку: приветствие, потребность, предложение, заказ.</span>
              <div className="script-empty__actions">
                <button type="button" className="btn-accent" onClick={() => { const next = templateSteps(); change(next, next[0]!.id); }}>
                  Начать с шаблона
                </button>
                <button type="button" className="btn" onClick={() => add(null)}>Добавить шаг</button>
              </div>
            </>
          ) : <span>Владелец ещё не написал скрипт продаж.</span>}
        </div>
      ) : (
        <div className={`script-tab__layout${selected ? ' script-tab__layout--open' : ''}`}>
          <ol className="script-chain" aria-label="Шаги скрипта">
            {owner && !full && (
              <li className="script-chain__insert"><button type="button" className="btn-link" onClick={() => add('start')}>+ Шаг</button></li>
            )}
            {roots.map((root, rootIndex) => {
              const branches = steps.filter((step) => step.parentId === root.id);
              return (
                <Fragment key={root.id}>
                  <li className="script-block">
                    <StepCard
                      step={root}
                      number={numbers.get(root.id)!}
                      selected={root.id === selectedId}
                      owner={owner}
                      stages={stages}
                      canUp={rootIndex > 0}
                      canDown={rootIndex < roots.length - 1}
                      onOpen={() => setSelectedId(root.id)}
                      onMove={(by) => change(moveStep(steps, root.id, by))}
                      onRemove={() => remove(root)}
                      onBranch={full ? undefined : () => branch(root.id)}
                    />
                    {branches.length > 0 && (
                      <ul className="script-branches" aria-label={`Ветки шага ${numbers.get(root.id)}`}>
                        {branches.map((item, index) => (
                          <li key={item.id} className="script-branch">
                            <span className="script-branch__arrow">↳ {item.condition.trim() || 'условие не написано'}</span>
                            <StepCard
                              step={item}
                              number={numbers.get(item.id)!}
                              selected={item.id === selectedId}
                              owner={owner}
                              stages={stages}
                              canUp={index > 0}
                              canDown={index < branches.length - 1}
                              onOpen={() => setSelectedId(item.id)}
                              onMove={(by) => change(moveStep(steps, item.id, by))}
                              onRemove={() => remove(item)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                  {rootIndex < roots.length - 1 ? (
                    <li className="script-chain__arrow" aria-hidden={!owner || full}>
                      {owner && !full && <button type="button" className="btn-link" onClick={() => add(root.id)}>+ Шаг</button>}
                    </li>
                  ) : owner && !full && (
                    <li className="script-chain__insert"><button type="button" className="btn-link" onClick={() => add(root.id)}>+ Шаг</button></li>
                  )}
                </Fragment>
              );
            })}
          </ol>

          {selected && (
            <StepPanel
              key={selected.id}
              agentId={agentId}
              step={selected}
              number={numbers.get(selected.id)!}
              readOnly={readOnly}
              stages={stages}
              fields={fields}
              products={products}
              onChange={(patch) => change(updateStep(steps, selected.id, patch))}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function StepCard({ step, number, selected, owner, stages, canUp, canDown, onOpen, onMove, onRemove, onBranch }: {
  step: DraftStep;
  number: string;
  selected: boolean;
  owner: boolean;
  stages: Stage[];
  canUp: boolean;
  canDown: boolean;
  onOpen: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onBranch?: () => void;
}) {
  const stage = stages.find((item) => item.id === step.stageId);
  const preview = step.instructions.replace(/\s+/g, ' ').trim();
  return (
    <article className={`script-card${selected ? ' script-card--selected' : ''}${step.parentId ? ' script-card--branch' : ''}`}>
      <button type="button" className="script-card__open" aria-pressed={selected} onClick={onOpen}>
        <span className="script-card__number">{number}</span>
        <span className="script-card__body">
          <span className="script-card__title">{step.title.trim() || 'Без названия'}</span>
          {preview && <span className="script-card__preview">{preview}</span>}
          <span className="script-card__chips">
            {step.photoIds.length > 0 && <span className="script-chip">📷 {step.photoIds.length} фото</span>}
            {step.fieldIds.length > 0 && <span className="script-chip">поля: {step.fieldIds.length}</span>}
            {step.handoff && <span className="script-chip">сотрудник</span>}
            {step.waitPayment && <span className="script-chip script-chip--pay">ждать оплату</span>}
            {stage && (
              <span className="script-chip">
                <span className="script-chip__dot" style={{ background: stage.color }} aria-hidden="true" />
                {stage.name}
              </span>
            )}
          </span>
        </span>
      </button>
      {owner && (
        <span className="script-card__tools">
          <button type="button" className="btn-sm" aria-label={`Шаг ${number} выше`} disabled={!canUp} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="btn-sm" aria-label={`Шаг ${number} ниже`} disabled={!canDown} onClick={() => onMove(1)}>↓</button>
          {onBranch && <button type="button" className="btn-sm" onClick={onBranch}>+ Ветка</button>}
          <button type="button" className="btn-sm" aria-label={`Удалить шаг ${number}`} onClick={onRemove}>✕</button>
        </span>
      )}
    </article>
  );
}

export function StepPanel({ agentId, step, number, readOnly, stages, fields, products, onChange, onClose }: {
  agentId: string;
  step: DraftStep;
  number: string;
  readOnly: boolean;
  stages: Stage[];
  fields: LeadField[];
  products: Product[];
  onChange: (patch: Partial<DraftStep>) => void;
  onClose: () => void;
}) {
  const branch = step.parentId !== null;
  const withPhotos = products.filter((product) => product.photos.length > 0);
  const togglePhoto = (id: string) => onChange({
    photoIds: step.photoIds.includes(id) ? step.photoIds.filter((item) => item !== id)
      : step.photoIds.length >= STEP_PHOTOS ? step.photoIds : [...step.photoIds, id],
  });
  const toggleField = (id: string) => onChange({
    fieldIds: step.fieldIds.includes(id) ? step.fieldIds.filter((item) => item !== id)
      : step.fieldIds.length >= STEP_FIELDS ? step.fieldIds : [...step.fieldIds, id],
  });

  return (
    <section className="script-panel" aria-labelledby="script-panel-title">
      <div className="knowledge-panel-head">
        <div>
          <p className="knowledge-kicker">{branch ? `Ветка ${number}` : `Шаг ${number}`}</p>
          <h2 id="script-panel-title">{step.title.trim() || 'Без названия'}</h2>
        </div>
        <button type="button" className="btn-link" onClick={onClose}>Закрыть</button>
      </div>

      <fieldset className="script-panel__form" disabled={readOnly}>
        <label className="products-editor__label" htmlFor="script-step-title">Название</label>
        <input id="script-step-title" className="knowledge-control" value={step.title} maxLength={TITLE_MAX}
          onChange={(event) => onChange({ title: event.target.value })} />

        {branch && (
          <>
            <label className="products-editor__label" htmlFor="script-step-condition">Когда агент идёт в эту ветку</label>
            <input id="script-step-condition" className="knowledge-control" value={step.condition} maxLength={CONDITION_MAX}
              placeholder="Например, клиент говорит «дорого» или «подумаю»" onChange={(event) => onChange({ condition: event.target.value })} />
          </>
        )}

        <label className="products-editor__label" htmlFor="script-step-instructions">Что делает агент</label>
        <textarea id="script-step-instructions" className="knowledge-control" rows={5} value={step.instructions} maxLength={INSTRUCTIONS_MAX}
          placeholder="Что сказать и что сделать на этом шаге — своими словами"
          onChange={(event) => onChange({ instructions: event.target.value })} />

        <label className="products-editor__label" htmlFor="script-step-stage">Этап воронки</label>
        <select id="script-step-stage" className="knowledge-control" value={step.stageId ?? ''}
          onChange={(event) => onChange({ stageId: event.target.value || null })}>
          <option value="">Не менять этап</option>
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </select>

        <p className="products-editor__label">Фото для отправки · {step.photoIds.length} из {STEP_PHOTOS}</p>
        {withPhotos.length === 0 ? (
          <p className="products-editor__note">В каталоге нет фото. Добавьте их во вкладке «Товары».</p>
        ) : (
          <div className="script-photos">
            {withPhotos.map((product) => (
              <div key={product.id} className="script-photos__product">
                <span className="script-photos__name">{product.name}</span>
                <ul className="script-photos__grid">
                  {product.photos.map((photo) => {
                    const on = step.photoIds.includes(photo.id);
                    return (
                      <li key={photo.id}>
                        <button type="button" className={`script-photo${on ? ' script-photo--on' : ''}`} aria-pressed={on}
                          aria-label={`${product.name}: ${photo.caption ?? 'фото'}`}
                          disabled={readOnly || (!on && step.photoIds.length >= STEP_PHOTOS)} onClick={() => togglePhoto(photo.id)}>
                          <img src={api.productPhotoUrl(agentId, product.id, photo.id)} alt="" loading="lazy" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
        <p className="products-editor__note">Агент отправит эти фото в первом ответе на шаге.</p>

        <p className="products-editor__label">Что узнать у клиента</p>
        {fields.length === 0 ? (
          <p className="products-editor__note">Полей сделки нет. Их добавляют в настройках воронки.</p>
        ) : (
          <div className="script-fields">
            {fields.map((field) => (
              <label key={field.id} className="products-editor__check">
                <input type="checkbox" checked={step.fieldIds.includes(field.id)}
                  disabled={readOnly || (!step.fieldIds.includes(field.id) && step.fieldIds.length >= STEP_FIELDS)}
                  onChange={() => toggleField(field.id)} />
                {field.name}
              </label>
            ))}
          </div>
        )}

        <label className="products-editor__check">
          <input type="checkbox" checked={step.handoff} onChange={(event) => onChange({ handoff: event.target.checked })} />
          Позвать сотрудника
        </label>
        {step.handoff && (
          <input className="knowledge-control" aria-label="Что сделать сотруднику" value={step.handoffNote} maxLength={NOTE_MAX}
            placeholder="Что должен сделать сотрудник" onChange={(event) => onChange({ handoffNote: event.target.value })} />
        )}

        <label className="products-editor__check">
          <input type="checkbox" checked={step.waitPayment} onChange={(event) => onChange({ waitPayment: event.target.checked })} />
          Ждать оплату
        </label>
        <p className="products-editor__note">Агент не перейдёт к следующим шагам и не отправит их фото, пока система не подтвердит оплату.</p>
      </fieldset>
    </section>
  );
}
