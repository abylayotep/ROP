import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { canCoachFrom, coachLink } from './DialogsScreen.js';

const aiMessage: Message = {
  id: 'm1',
  direction: 'out',
  author: 'ai',
  kind: 'text',
  body: 'Доставка стоит 1500 ₸.',
  hasMedia: false,
  mediaMime: null,
  status: 'sent',
  sentAt: '2026-09-08T10:00:00.000Z',
};

describe('canCoachFrom', () => {
  it('shows the button on the agent\'s own answer, for the owner', () => {
    expect(canCoachFrom(aiMessage, 'owner')).toBe(true);
  });

  it('hides it from a member — «Обучение» refuses everyone but the owner', () => {
    expect(canCoachFrom(aiMessage, 'member')).toBe(false);
  });

  it('hides it from a client\'s own message', () => {
    expect(canCoachFrom({ ...aiMessage, direction: 'in', author: 'client' }, 'owner')).toBe(false);
  });

  it('hides it from an operator\'s manual reply — nothing was ever built from a rule here', () => {
    expect(canCoachFrom({ ...aiMessage, author: 'operator' }, 'owner')).toBe(false);
  });
});

describe('coachLink', () => {
  it('carries the conversation id and nothing else — never the message text', () => {
    expect(coachLink('c1')).toBe('../coach?conversation=c1');
  });
});
