import { useState } from 'react';
import type { KbNote } from '@/types';

/**
 * The left pane's folder tree.
 *
 * `buildTree` is a pure function on purpose: task 11's graph view groups the same notes by
 * the same rule, and a function it can import and test on its own is worth more than a
 * component neither screen can reuse.
 */

export interface TreeNode {
  name: string;
  /** The full path down to this node — a note's own path for a leaf, a folder's for a branch. */
  path: string;
  children: TreeNode[];
  /** Null for a folder. A leaf can still carry both, if a note's path is also a folder's prefix. */
  note: KbNote | null;
}

/**
 * Groups notes by their `/`-separated path into a tree, folders and leaves alike.
 *
 * Folders sort before loose notes at every level, and within each group the sort is
 * `localeCompare('ru')` — the alphabet a Russian-speaking seller expects, not code-point
 * order, which would put «Я» after every Latin letter and before none of the Cyrillic ones
 * a person actually types.
 */
export function buildTree(notes: KbNote[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const note of notes) {
    const segments = note.path.split('/');
    let level = root;
    let prefix = '';

    segments.forEach((name, index) => {
      prefix = prefix === '' ? name : `${prefix}/${name}`;
      let node = level.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, path: prefix, children: [], note: null };
        level.push(node);
      }
      if (index === segments.length - 1) node.note = note;
      level = node.children;
    });
  }

  sortTree(root);
  return root;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.children.length > 0;
    const bFolder = b.children.length > 0;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
  for (const node of nodes) sortTree(node.children);
}

export function NoteTree({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: TreeNode[];
  selectedId: string | null;
  onSelect: (noteId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={0} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (noteId: string) => void;
}) {
  const isFolder = node.children.length > 0;
  // Open by default: a vault with a handful of folders should show everything on first
  // look, and collapsing is for once it has grown past that.
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        type="button"
        onClick={() => (isFolder ? setOpen((was) => !was) : node.note && onSelect(node.note.id))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
          padding: '6px 10px',
          paddingLeft: 10 + depth * 14,
          border: 0,
          borderRadius: 6,
          background: node.note?.id === selectedId ? 'var(--accent-a10)' : 'transparent',
          font: 'inherit',
          cursor: 'pointer',
          color: node.note?.id === selectedId ? 'var(--accent)' : 'inherit',
        }}
      >
        {isFolder && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 10, flex: '0 0 auto' }}>
            {open ? '▾' : '▸'}
          </span>
        )}
        <span
          className="ellipsis"
          style={{ fontSize: 12.5, fontWeight: isFolder ? 650 : 500, flex: 1, minWidth: 0 }}
        >
          {node.name}
        </span>
        {node.note?.edited && (
          <span
            title="Изменено вручную"
            style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--warn)', flex: '0 0 auto' }}
          />
        )}
      </button>

      {isFolder && open && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
