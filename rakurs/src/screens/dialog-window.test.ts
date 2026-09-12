import { describe, expect, it } from 'vitest';
import { messageWindow } from './dialog-window';

const messages = Array.from({ length: 10000 }, (_, index) => ({ id: String(index) }));

describe('messageWindow', () => {
  it('bounds the initial transcript to the latest page', () => {
    expect(messageWindow(messages, null, null)).toEqual({ start: 9940, end: 10000 });
  });
  it('opens an old source message without mounting the rest of the history', () => {
    const window = messageWindow(messages, null, '100');
    expect(window.start).toBeLessThanOrEqual(100);
    expect(window.end).toBeGreaterThan(100);
    expect(window.end - window.start).toBe(60);
  });
  it('allows paging through older and newer messages without growing the DOM', () => {
    expect(messageWindow(messages, 9880, null)).toEqual({ start: 9880, end: 9940 });
    expect(messageWindow(messages, 9940, null)).toEqual({ start: 9940, end: 10000 });
  });
  it('falls back to the latest page for a missing source and handles short histories', () => {
    expect(messageWindow(messages, null, 'missing')).toEqual({ start: 9940, end: 10000 });
    expect(messageWindow(messages.slice(0, 3), null, '0')).toEqual({ start: 0, end: 3 });
    expect(messageWindow([], null, null)).toEqual({ start: 0, end: 0 });
  });
});
