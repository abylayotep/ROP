import { describe, expect, it } from 'vitest';
import { describeProposal } from './ProposalCard.js';

const rules = [{ id: 'r1', category: 'tone' as const, text: 'На «вы».', enabled: true,
  origin: 'manual' as const, position: 0, warning: null, updatedAt: '' }];

describe('describeProposal', () => {
  it('names a new rule by its category', () => {
    expect(describeProposal({ kind: 'rule', category: 'forbid', text: 'Не обещай скидку.' }, rules).title)
      .toBe('Новое правило: чего не делать');
  });

  it('names an edited rule by the rule it edits', () => {
    expect(describeProposal({ kind: 'rule_edit', ruleId: 'r1', text: 'Только на «вы».' }, rules).title)
      .toBe('Правка правила «На «вы».»');
  });

  it('names a switched-off rule as switching off', () => {
    expect(describeProposal({ kind: 'rule_edit', ruleId: 'r1', enabled: false }, rules).title)
      .toBe('Выключить правило «На «вы».»');
  });

  it('names a new note by its path', () => {
    expect(describeProposal({ kind: 'note', path: 'Доставка', body: '1500 ₸.' }, rules).title)
      .toBe('Новая заметка «Доставка»');
  });
});
