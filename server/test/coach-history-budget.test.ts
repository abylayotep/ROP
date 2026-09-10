/**
 * The character budget over a coaching conversation's history.
 *
 * `budgetHistory` is pure — a list of turns in, a shorter list out — so this file needs no
 * database, the same reason `ai-prompt.test.ts` opens no connection either. The behaviour
 * that actually matters (the route applying this before the history reaches the model) is
 * covered where it has to be, in `coach-api.test.ts`'s own history test; this file is about
 * the budgeting rule itself: newest first, whole messages only.
 */
import { describe, expect, it } from 'vitest';
import { HISTORY_BUDGET_CHARS, budgetHistory, type CoachTurn } from '../src/lib/ai/coach.js';

function turn(role: 'owner' | 'model', text: string): CoachTurn {
  return { role, text };
}

describe('budgetHistory', () => {
  it('keeps every turn when the whole history fits under the budget', () => {
    const turns = [turn('owner', 'Первое.'), turn('model', 'Понял.'), turn('owner', 'Второе.')];
    expect(budgetHistory(turns, 1000)).toEqual(turns);
  });

  it('drops the oldest turns first, keeping the newest ones whole', () => {
    const turns = [turn('owner', 'a'.repeat(50)), turn('model', 'b'.repeat(50)), turn('owner', 'c'.repeat(50))];
    // Room for the newest two turns (100 chars) but not the oldest as well (150).
    const kept = budgetHistory(turns, 100);
    expect(kept).toEqual(turns.slice(1));
  });

  it('never cuts a message in half: a turn that does not fit whole is dropped, not truncated', () => {
    const turns = [turn('owner', 'a'.repeat(10)), turn('model', 'b'.repeat(90))];
    // The newest turn (90 chars) fits; adding the older 10-char turn would cross 95.
    const kept = budgetHistory(turns, 95);
    expect(kept).toEqual([turns[1]]);
    for (const t of kept) expect(t.text.length).toBeGreaterThan(0);
  });

  it('keeps nothing when even the single newest turn alone exceeds the budget', () => {
    const turns = [turn('owner', 'a'.repeat(10)), turn('model', 'b'.repeat(200))];
    expect(budgetHistory(turns, 100)).toEqual([]);
  });

  it('returns an empty list for an empty history', () => {
    expect(budgetHistory([], HISTORY_BUDGET_CHARS)).toEqual([]);
  });

  it('HISTORY_BUDGET_CHARS is a real, positive cap', () => {
    // Not asserting an exact figure the comment can drift from unnoticed — only that it is
    // the kind of number a real cap should be: positive, and not so small a single ordinary
    // owner message could not survive it.
    expect(HISTORY_BUDGET_CHARS).toBeGreaterThan(4_000);
  });
});
