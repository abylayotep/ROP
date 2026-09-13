import { describe, expect, it } from 'vitest';
import { legacyCoachSearch, legacyKnowledgeSearch, teachModeFromSearch, trainingSearch,
  teachModeSearch, trainingTabFromSearch, visibleTabs, withoutCorrectionParams } from './training-routes';

const p = (s: string) => new URLSearchParams(s);
const owner = { owner: true, noteCount: 5 };

describe('training routes', () => {
  it('shows five tabs to the owner and three to others', () => {
    expect(visibleTabs(true)).toEqual(['knowledge', 'products', 'replies', 'teach', 'review']);
    expect(visibleTabs(false)).toEqual(['knowledge', 'products', 'replies']);
    expect(trainingTabFromSearch(p('tab=products'), { owner: false, noteCount: 5 })).toBe('products');
  });
  it('honours a valid tab and ignores tabs a non-owner cannot see', () => {
    expect(trainingTabFromSearch(p('tab=review'), owner)).toBe('review');
    expect(trainingTabFromSearch(p('tab=review'), { owner: false, noteCount: 5 })).toBe('knowledge');
    expect(trainingTabFromSearch(p('tab=nope'), owner)).toBe('knowledge');
  });
  it('opens teach for deep links and for an empty base', () => {
    expect(trainingTabFromSearch(p('generation=r1'), owner)).toBe('teach');
    expect(trainingTabFromSearch(p('conversation=c1&reply=a1'), owner)).toBe('teach');
    expect(trainingTabFromSearch(p(''), { owner: true, noteCount: 0 })).toBe('teach');
    expect(trainingTabFromSearch(p(''), { owner: true, noteCount: null })).toBe('knowledge');
    expect(trainingTabFromSearch(p(''), { owner: false, noteCount: 0 })).toBe('knowledge');
  });
  it('derives the teach mode', () => {
    expect(teachModeFromSearch(p('teach=import&generation=r1'))).toBe('import');
    expect(teachModeFromSearch(p('generation=r1'))).toBe('chats');
    expect(teachModeFromSearch(p('session=s1&turn=t1'))).toBe('coach');
    expect(teachModeFromSearch(p('teach=bad'))).toBeNull();
  });
  it('builds tab URLs and drops state that belongs to the tab being left', () => {
    expect(trainingSearch(p('tab=teach&teach=chats&generation=r1'), 'review').toString()).toBe('tab=review');
    expect(trainingSearch(p('tab=knowledge&note=n1'), 'teach', 'coach').toString()).toBe('tab=teach&teach=coach');
    expect(trainingSearch(p('tab=teach&teach=chats'), 'teach', null).toString()).toBe('tab=teach');
  });
  it('removes only correction params', () => {
    expect(withoutCorrectionParams(p('tab=teach&teach=coach&conversation=c&reply=r&message=m')).toString())
      .toBe('tab=teach&teach=coach');
  });
  it('maps legacy knowledge URLs', () => {
    expect(legacyKnowledgeSearch(p('')).toString()).toBe('tab=knowledge');
    expect(legacyKnowledgeSearch(p('note=n1')).toString()).toBe('note=n1&tab=knowledge');
    expect(legacyKnowledgeSearch(p('tab=runs&generation=r1')).toString()).toBe('tab=teach&generation=r1&teach=chats');
    expect(legacyKnowledgeSearch(p('generation=r1')).toString()).toBe('generation=r1&tab=teach&teach=chats');
    expect(legacyKnowledgeSearch(p('tab=sources')).toString()).toBe('tab=teach&teach=import');
  });
  it('maps legacy coach URLs and keeps correction params', () => {
    expect(legacyCoachSearch(p('conversation=c1&reply=a1')).toString())
      .toBe('conversation=c1&reply=a1&tab=teach&teach=coach');
  });
  it('switches the teach way with a fresh start', () => {
    expect(teachModeSearch(p('tab=teach&teach=import&generation=old&conversation=c'), 'chats').toString())
      .toBe('tab=teach&teach=chats');
    expect(teachModeSearch(p('tab=teach&teach=coach&reply=r'), null).toString()).toBe('tab=teach');
  });
});
