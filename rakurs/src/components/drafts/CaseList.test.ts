import { describe, expect, it } from 'vitest';
import type { TestCase } from '@/types';
import { ORIGIN_LABEL } from './CaseList';

describe('ORIGIN_LABEL', () => {
  it('names every case origin, including cases the autopilot came up with', () => {
    const origins: TestCase['origin'][] = ['manual', 'dialog', 'generated', 'correction', 'suggested'];
    for (const origin of origins) expect(ORIGIN_LABEL[origin]).toEqual(expect.any(String));
    expect(ORIGIN_LABEL.suggested).toBe('придумано');
  });
});
