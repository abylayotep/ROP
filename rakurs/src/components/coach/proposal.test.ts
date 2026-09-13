import { describe, expect, it } from 'vitest';
import { describeProposal } from './ProposalCard.js';
import { needsProposalReconciliation, proposalWithText } from './proposal';

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

  it('degrades to an unnamed rule_edit when the ruleId is not in the list', () => {
    const result = describeProposal({ kind: 'rule_edit', ruleId: 'gone', text: 'Только на «вы».' }, rules);
    expect(result.title).toBe('Правка правила');
    expect(result.body).toBe('Только на «вы».');
  });

  it('names a note_edit without a path, since this function is never handed notes', () => {
    expect(describeProposal({ kind: 'note_edit', noteId: 'n1', body: 'Доставка бесплатна от 10000 ₸.' }, rules))
      .toEqual({ title: 'Правка заметки', body: 'Доставка бесплатна от 10000 ₸.' });
  });
});

describe('proposalWithText', () => {
  it('replaces only the editable content of a rule edit', () => {
    expect(proposalWithText({ kind: 'rule_edit', ruleId: 'target', enabled: false, text: 'Old' }, 'New')).toEqual({
      kind: 'rule_edit', ruleId: 'target', enabled: false, text: 'New',
    });
  });

  it('replaces note content without changing its target', () => {
    expect(proposalWithText({ kind: 'note_edit', noteId: 'target', body: 'Old' }, 'New')).toEqual({
      kind: 'note_edit', noteId: 'target', body: 'New',
    });
  });
});

describe('needsProposalReconciliation', () => {
  it('clears a conflict when the reloaded proposal already contains the preserved text', () => {
    expect(needsProposalReconciliation('Edited wording.', 'Edited wording.')).toBe(false);
  });

  it('keeps the conflict when the saved proposal differs from the preserved text', () => {
    expect(needsProposalReconciliation('Edited wording.', 'Another edit.')).toBe(true);
  });
});
