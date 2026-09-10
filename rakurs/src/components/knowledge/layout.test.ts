import { describe, expect, it } from 'vitest';
import { layout } from './layout.js';

const graph = {
  notes: [
    { id: 'a', title: 'А', path: 'А' },
    { id: 'b', title: 'Б', path: 'Б' },
    { id: 'c', title: 'В', path: 'В' },
  ],
  links: [{ from: 'a', to: 'b' }],
  truncated: false,
};

describe('layout', () => {
  it('places every note', () => {
    expect([...layout(graph, 50).keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic', () => {
    expect([...layout(graph, 50)]).toEqual([...layout(graph, 50)]);
  });

  it('pulls linked notes closer than unlinked ones', () => {
    const at = layout(graph, 200);
    const d = (x: string, y: string) =>
      Math.hypot(at.get(x)!.x - at.get(y)!.x, at.get(x)!.y - at.get(y)!.y);
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
  });

  it('renders a single note without dividing by zero', () => {
    const one = layout({ notes: [{ id: 'a', title: 'А', path: 'А' }], links: [], truncated: false }, 50);
    const p = one.get('a')!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it('renders an empty graph as an empty map', () => {
    expect(layout({ notes: [], links: [], truncated: false }, 50).size).toBe(0);
  });
});
