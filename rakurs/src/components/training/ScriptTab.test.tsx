import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, SalesScript, Stage } from '@/types';

const fixture = vi.hoisted(() => ({
  script: undefined as SalesScript | undefined,
  stages: [] as Stage[],
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: (fetcher: unknown) => {
    const source = String(fetcher);
    const data = source.includes('getSalesScript') ? fixture.script : source.includes('listStages') ? fixture.stages : [];
    return { data, error: undefined, reload: vi.fn(), loading: false };
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: vi.fn(), fail: vi.fn() }) }));
import {
  addBranch,
  addStep,
  blankStep,
  draftOf,
  moveStep,
  removeStep,
  saveRequest,
  ScriptEditor,
  ScriptTab,
  stepNumbers,
  StepPanel,
  templateSteps,
  type DraftStep,
} from './ScriptTab';

const step = (id: string, over: Partial<DraftStep> = {}): DraftStep => blankStep({ id, title: id, ...over });
const ids = (steps: DraftStep[]) => steps.map((item) => item.id);

const saved: SalesScript = {
  steps: [
    { ...step('s1', { title: 'Приветствие', instructions: 'Поздоровайся\nи представься.' }), position: 0 },
    { ...step('s2', { title: 'Фото дизайнов', photoIds: ['p1', 'p2'], stageId: 'stage-1' }), position: 1 },
    { ...step('b1', { parentId: 's2', title: 'Сомневается', condition: 'Клиент говорит «подумаю»', handoff: true }), position: 0 },
    { ...step('s3', { title: 'Оплата', waitPayment: true, fieldIds: ['f1'] }), position: 2 },
  ],
};

const tab = (owner: boolean) => renderToStaticMarkup(createElement(ScriptTab, { agentId: 'agent-1', owner }));

beforeEach(() => {
  fixture.script = saved;
  fixture.stages = [{ id: 'stage-1', name: 'Выбор', color: '#12b37d', kind: 'active', position: 0, description: '', agentGoal: '', autoMessage: null }];
});

describe('ScriptTab', () => {
  it('draws the chain with numbers, previews, action chips and the branch beside its step', () => {
    const html = tab(true);
    expect(html).toContain('Приветствие');
    expect(html).toContain('Поздоровайся и представься.');
    expect(html).toContain('📷 2 фото');
    expect(html).toContain('поля: 1');
    expect(html).toContain('сотрудник');
    expect(html).toContain('ждать оплату');
    expect(html).toContain('Выбор');
    expect(html).toContain('background:#12b37d');
    expect(html).toContain('↳ Клиент говорит «подумаю»');
    expect(html).toContain('>2.а<');
    expect(html).toContain('+ Ветка');
    expect(html).toContain('+ Шаг');
    expect(html.indexOf('Фото дизайнов')).toBeLessThan(html.indexOf('Сомневается'));
    expect(html.indexOf('Сомневается')).toBeLessThan(html.indexOf('Оплата'));
  });

  it('shows members the chain without any editing controls', () => {
    const html = tab(false);
    expect(html).toContain('Фото дизайнов');
    expect(html).not.toContain('+ Шаг');
    expect(html).not.toContain('+ Ветка');
    expect(html).not.toContain('Сохранить');
    expect(html).not.toContain('Удалить шаг');
  });

  it('offers the owner a template when there is no script, and members a sentence', () => {
    fixture.script = { steps: [] };
    expect(tab(true)).toContain('Начать с шаблона');
    expect(tab(false)).toContain('Владелец ещё не написал скрипт продаж');
    expect(tab(false)).not.toContain('Начать с шаблона');
  });

  it('opens the first step in the panel with its fields, and keeps it read-only for members', () => {
    const products: Product[] = [{ id: 'prod', name: 'Экслибрис', description: '', position: 0, active: true, variants: [],
      photos: [{ id: 'p1', mime: 'image/jpeg', sizeBytes: 1, filename: '', caption: 'Дизайн 1', position: 0, createdAt: '' }],
      createdAt: '', updatedAt: '' }];
    const panel = (readOnly: boolean, item: DraftStep) => renderToStaticMarkup(createElement(StepPanel, {
      agentId: 'agent-1', step: item, number: '2.а', readOnly, stages: fixture.stages,
      fields: [{ id: 'f1', name: 'Адрес', kind: 'text', hint: '', position: 0 }], products,
      onChange: () => undefined, onClose: () => undefined,
    }));
    const branch = draftOf(saved.steps)[2]!;
    const html = panel(false, branch);
    expect(html).toContain('Ветка 2.а');
    expect(html).toContain('Когда агент идёт в эту ветку');
    expect(html).toContain('Что делает агент');
    expect(html).toContain('Не менять этап');
    expect(html).toContain('/agents/agent-1/products/prod/photos/p1/file');
    expect(html).toContain('Адрес');
    expect(html).toContain('Позвать сотрудника');
    expect(html).toContain('Ждать оплату');
    expect(html).not.toContain('<fieldset class="script-panel__form" disabled=""');
    expect(panel(true, branch)).toContain('<fieldset class="script-panel__form" disabled=""');
    expect(panel(false, draftOf(saved.steps)[0]!)).not.toContain('Когда агент идёт в эту ветку');
  });

  it('shows the save button only with changes', () => {
    const editor = (dirty: boolean) => renderToStaticMarkup(createElement(ScriptEditor, {
      agentId: 'agent-1', owner: true, steps: draftOf(saved.steps), dirty, stages: [], fields: [], products: [],
      onChange: () => undefined, onSaved: () => undefined,
    }));
    expect(editor(true)).toContain('Есть несохранённые изменения');
    expect(editor(false)).not.toContain('Есть несохранённые изменения');
    expect(editor(false)).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить<\/button>/);
  });
});

describe('script tree helpers', () => {
  const chain = () => [step('a'), step('a1', { parentId: 'a' }), step('b'), step('c')];

  it('adds a main step after a block, at the start and at the end', () => {
    expect(ids(addStep(chain(), 'a', step('new')))).toEqual(['a', 'a1', 'new', 'b', 'c']);
    expect(ids(addStep(chain(), 'start', step('new')))).toEqual(['new', 'a', 'a1', 'b', 'c']);
    expect(ids(addStep(chain(), null, step('new')))).toEqual(['a', 'a1', 'b', 'c', 'new']);
  });

  it('adds a branch after the existing branches of its step, and never under a branch', () => {
    const next = addBranch(chain(), 'a', step('a2'));
    expect(ids(next)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
    expect(next[2]!.parentId).toBe('a');
    expect(addBranch(chain(), 'a1', step('x'))).toEqual(chain());
  });

  it('moves a main step with its branches, and a branch only among its siblings', () => {
    expect(ids(moveStep(chain(), 'b', -1))).toEqual(['b', 'a', 'a1', 'c']);
    expect(ids(moveStep(chain(), 'a', 1))).toEqual(['b', 'a', 'a1', 'c']);
    expect(ids(moveStep(chain(), 'c', 1))).toEqual(ids(chain()));
    const two = addBranch(chain(), 'a', step('a2'));
    expect(ids(moveStep(two, 'a2', -1))).toEqual(['a', 'a2', 'a1', 'b', 'c']);
    expect(ids(moveStep(two, 'a2', 1))).toEqual(ids(two));
  });

  it('removes a step with its branches', () => {
    expect(ids(removeStep(chain(), 'a'))).toEqual(['b', 'c']);
    expect(ids(removeStep(chain(), 'a1'))).toEqual(['a', 'b', 'c']);
  });

  it('numbers main steps and branches the way the agent reads them', () => {
    const numbers = stepNumbers(addBranch(chain(), 'a', step('a2')));
    expect([...numbers.values()]).toEqual(['1', '1.а', '1.б', '2', '3']);
  });

  it('builds the save payload: parents by client id, trimmed text, no condition on main steps', () => {
    let steps = addStep([], null, step('tmp-1', { title: ' Приветствие ', condition: 'лишнее' }));
    steps = addBranch(steps, 'tmp-1', step('tmp-2', { title: 'Сомневается', condition: ' если дорого ' }));
    steps = addStep(steps, null, step('tmp-3', { title: 'Оплата', waitPayment: true, handoffNote: 'забытая заметка' }));
    const body = saveRequest(steps);
    expect(body).toEqual({ ok: true, steps: [
      { ...steps[0], title: 'Приветствие', condition: '' },
      { ...steps[1], condition: 'если дорого' },
      { ...steps[2], handoffNote: '' },
    ] });
    expect(body.ok && body.steps.map((item) => [item.id, item.parentId])).toEqual([['tmp-1', null], ['tmp-2', 'tmp-1'], ['tmp-3', null]]);
    expect(saveRequest([step('x', { title: '  ' })])).toEqual({ ok: false, message: 'Укажите название шага 1', stepId: 'x' });
  });

  it('starts from the seven-step template with payment waited for', () => {
    const template = templateSteps();
    expect(template.map((item) => item.title)).toEqual(
      ['Приветствие', 'Выбор товара', 'Размер и цена', 'Адрес', 'Доставка', 'Оплата', 'После оплаты']);
    expect(template.filter((item) => item.waitPayment).map((item) => item.title)).toEqual(['Оплата']);
    expect(template.every((item) => item.id.startsWith('tmp-') && item.parentId === null)).toBe(true);
  });
});
