import { describe, expect, it } from 'vitest';
import type { KbNote } from '@/types';
import { buildTree } from './NoteTree.js';

// Typed as `KbNote` rather than `as const`: a literal-typed `tags: []` infers `readonly []`,
// which is not the mutable `string[]` the real type carries, and `buildTree` should be
// tested against exactly the shape it is given in production.
const note = (path: string): KbNote => ({
  id: path,
  path,
  title: path.split('/').pop()!,
  kind: 'other',
  tags: [],
  edited: false,
  sourceId: null,
  sourceTitle: null,
  updatedAt: '',
});

describe('buildTree', () => {
  it('makes a folder out of a path segment', () => {
    const tree = buildTree([note('Товары/Двери'), note('Товары/Окна'), note('Доставка')]);
    expect(tree.map((n) => n.name)).toEqual(['Товары', 'Доставка']);
    expect(tree[0]!.children.map((n) => n.name)).toEqual(['Двери', 'Окна']);
  });

  it('puts folders before loose notes and sorts each alphabetically', () => {
    const tree = buildTree([note('Яблоко'), note('Б/Один'), note('А/Два')]);
    expect(tree.map((n) => n.name)).toEqual(['А', 'Б', 'Яблоко']);
  });
});
