import { beforeEach, describe, expect, it } from 'vitest';
import { forgetLids, phoneForLid, rememberLid } from '../src/lib/whatsapp/linked/lid-directory.js';

describe('linked LID directory', () => {
  beforeEach(forgetLids);

  it('never resolves a mapping learned by another linked number', () => {
    rememberLid('number-a', 'lid-1', '77085807932');

    expect(phoneForLid('number-a', 'lid-1')).toBe('77085807932');
    expect(phoneForLid('number-b', 'lid-1')).toBeNull();
  });
});
