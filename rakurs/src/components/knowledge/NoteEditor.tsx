import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as api from '@/api';
import { kindLabel } from '@/components/knowledge/ImportPanel';
import { renderMarkdown, type InlineNode, type MarkdownNode } from '@/components/knowledge/markdown';
import { useToast } from '@/components/ui/Toast';
import type { KbNoteDetail } from '@/types';

/**
 * The centre pane: one note, read as prose or edited as text.
 *
 * Saving is the one explicit button below the textarea — nothing here writes to the store
 * the agent answers from until that button is pressed. A note's kind and tags are not a
 * separate form field either: they live in a `---\nkind: …\n---` block at the top of the
 * body, exactly as the import routes write it, so editing them is editing text like
 * everything else in a vault of notes rather than a special case this screen has to know
 * about.
 */

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const FRONTMATTER_LINE = /^[A-Za-z_]+:\s*.*$/;

/**
 * The frontmatter block, stripped for the read view — a reader wants the note, not its own
 * `kind:`/`tags:` header repeated as two stray paragraphs above it. Editing still sees it.
 *
 * Stripped only when every line inside really looks like `key: value` — the same check the
 * server makes before it trusts the block (`readFrontmatter` in `note.ts`). Without it, a
 * note that opens with its own `---` divider and happens to have a second `---` further
 * down would have everything between them silently swallowed as if it were someone else's
 * header.
 */
function forReading(body: string): string {
  const match = FRONTMATTER.exec(body);
  if (!match) return body;
  const isFrontmatter = match[1]!.split('\n').every((line) => FRONTMATTER_LINE.test(line.trim()));
  return isFrontmatter ? body.slice(match[0].length) : body;
}

const control: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  outline: 'none',
};

const proseSpacing: CSSProperties = { margin: '0 0 10px', lineHeight: 1.6 };

function headingStyle(level: number): CSSProperties {
  const size = [20, 17, 15, 13.5, 12.5, 12][Math.min(level, 6) - 1];
  return { ...proseSpacing, fontSize: size, fontWeight: 700, marginTop: level <= 2 ? 18 : 14 };
}

/** Where a `[[wiki link]]` in this note's own body resolves to, exactly as the server parsed
 * it when the note was last saved — the same lookup that fills in `detail.links`. */
function linkTargets(detail: KbNoteDetail): Map<string, string> {
  const map = new Map<string, string>();
  for (const link of detail.links) {
    if (link.noteId) map.set(link.title, link.noteId);
  }
  return map;
}

function renderInline(node: InlineNode, key: number, onOpenNote: ((noteId: string) => void) | undefined, targets: Map<string, string>): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'bold':
      return <strong key={key}>{node.text}</strong>;
    case 'italic':
      return <em key={key}>{node.text}</em>;
    case 'inline-code':
      return (
        <code key={key} className="mono" style={{ background: 'var(--sunken-2)', padding: '1px 5px', borderRadius: 4 }}>
          {node.text}
        </code>
      );
    case 'link': {
      const target = targets.get(node.target);
      if (node.broken || !target) {
        return (
          <span key={key} title="В базе нет заметки с таким названием" style={{ color: 'var(--danger)' }}>
            [[{node.label}]]
          </span>
        );
      }
      return (
        <button
          key={key}
          type="button"
          className="btn-link"
          style={{ fontSize: 'inherit', fontWeight: 'inherit' }}
          onClick={() => onOpenNote?.(target)}
        >
          {node.label}
        </button>
      );
    }
  }
}

/** Groups the flat node stream back into paragraphs, lists, headings, quotes and code. */
function MarkdownView({
  nodes,
  onOpenNote,
  targets,
}: {
  nodes: MarkdownNode[];
  onOpenNote?: (noteId: string) => void;
  targets: Map<string, string>;
}) {
  const blocks: ReactNode[] = [];
  let run: InlineNode[] = [];
  let list: { ordered: boolean; items: InlineNode[][] } | null = null;

  const isInline = (node: MarkdownNode): node is InlineNode =>
    node.kind === 'text' || node.kind === 'bold' || node.kind === 'italic' || node.kind === 'inline-code' || node.kind === 'link';

  const flushRun = () => {
    if (run.length === 0) return;
    blocks.push(
      <p key={blocks.length} style={proseSpacing}>
        {run.map((n, i) => renderInline(n, i, onOpenNote, targets))}
      </p>,
    );
    run = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length} style={{ ...proseSpacing, paddingLeft: 22 }}>
        {items.map((children, i) => (
          <li key={i}>{children.map((n, j) => renderInline(n, j, onOpenNote, targets))}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  for (const node of nodes) {
    if (isInline(node)) {
      flushList();
      run.push(node);
      continue;
    }
    if (node.kind === 'break') {
      flushRun();
      continue;
    }
    if (node.kind === 'list-item') {
      flushRun();
      if (list && list.ordered === node.ordered) list.items.push(node.children);
      else {
        flushList();
        list = { ordered: node.ordered, items: [node.children] };
      }
      continue;
    }
    flushRun();
    flushList();
    if (node.kind === 'heading') {
      const Tag = `h${Math.min(node.level, 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={blocks.length} style={headingStyle(node.level)}>
          {node.children.map((n, i) => renderInline(n, i, onOpenNote, targets))}
        </Tag>,
      );
    } else if (node.kind === 'blockquote') {
      blocks.push(
        <blockquote
          key={blocks.length}
          style={{ ...proseSpacing, margin: '0 0 10px', padding: '2px 14px', borderLeft: '3px solid var(--line-strong)', color: 'var(--text-3)' }}
        >
          {node.children.map((n, i) => renderInline(n, i, onOpenNote, targets))}
        </blockquote>
      );
    } else if (node.kind === 'code') {
      blocks.push(
        <pre
          key={blocks.length}
          className="mono sunken-box"
          style={{ padding: '10px 12px', overflowX: 'auto', fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}
        >
          <code>{node.text}</code>
        </pre>
      );
    }
  }
  flushRun();
  flushList();

  return <div>{blocks}</div>;
}

export function NoteEditor({
  agentId,
  detail,
  titles,
  onSaved,
  onDeleted,
  onCancel,
  onOpenNote,
}: {
  agentId: string;
  /** Null starts a blank note under a path the owner has yet to type. */
  detail: KbNoteDetail | null;
  /** Every note title in the vault — what `[[` offers and what a link is checked against. */
  titles: Set<string>;
  onSaved: (saved: KbNoteDetail) => void;
  onDeleted: () => void;
  /** A blank note abandoned without saving. Not offered once a note exists to go back to. */
  onCancel?: () => void;
  onOpenNote: (noteId: string) => void;
}) {
  const toast = useToast();
  const isNew = detail === null;

  const [editing, setEditing] = useState(isNew);
  const [path, setPath] = useState(detail?.path ?? '');
  const [body, setBody] = useState(detail?.body ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [suggest, setSuggest] = useState<{ from: number; query: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = isNew ? path.trim() !== '' || body.trim() !== '' : path !== detail.path || body !== detail.body;

  function updateSuggest(value: string, caret: number) {
    const uptoCaret = value.slice(0, caret);
    const open = uptoCaret.lastIndexOf('[[');
    if (open === -1) {
      setSuggest(null);
      return;
    }
    const between = uptoCaret.slice(open + 2);
    // Still an open `[[…` if nothing has closed or interrupted it since the marker.
    if (between.includes(']') || between.includes('\n')) {
      setSuggest(null);
      return;
    }
    setSuggest({ from: open, query: between });
  }

  function insertTitle(title: string) {
    if (!suggest || !textareaRef.current) return;
    const caret = textareaRef.current.selectionStart;
    const before = body.slice(0, suggest.from);
    const after = body.slice(caret);
    const inserted = `[[${title}]]`;
    setBody(`${before}${inserted}${after}`);
    setSuggest(null);
    const pos = before.length + inserted.length;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(pos, pos);
      textareaRef.current?.focus();
    });
  }

  async function save() {
    if (saving || path.trim() === '') return;
    setSaving(true);
    try {
      const saved = isNew
        ? await api.createKbNote(agentId, { path: path.trim(), body })
        : await api.updateKbNote(agentId, detail.id, { path: path.trim(), body });
      toast.ok('Сохранено');
      setEditing(false);
      onSaved(saved);
    } catch (error) {
      // A duplicate path answers 409 with its own Russian message — shown as it came,
      // with the draft left exactly as typed rather than reset by a refusal.
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    if (isNew) {
      onCancel?.();
      return;
    }
    setPath(detail.path);
    setBody(detail.body);
    setEditing(false);
  }

  async function remove() {
    if (isNew || deleting) return;
    if (!window.confirm(`Удалить заметку «${detail.title}»? Это нельзя отменить.`)) return;
    setDeleting(true);
    try {
      await api.deleteKbNote(agentId, detail.id);
      toast.ok('Заметка удалена');
      onDeleted();
    } catch (error) {
      toast.fail(error);
    } finally {
      setDeleting(false);
    }
  }

  const matches = suggest
    ? Array.from(titles)
        .filter((title) => title.toLowerCase().includes(suggest.query.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'ru'))
        .slice(0, 8)
    : [];

  // A genuine `if`, not a boolean stored and reused across the JSX below: only this gives
  // the type checker an actual narrowing of `detail`, and a blank note starts in `editing`
  // regardless, so there is no path back to view mode without saving first.
  if (!editing && detail) {
    const empty = forReading(detail.body).trim() === '';
    return (
      <div className="card card-pad">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ellipsis" style={{ fontSize: 15, fontWeight: 650 }}>
              {detail.title}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
              {detail.path} · {kindLabel(detail.kind)}
              {detail.edited && ' · изменено вручную'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
            <button type="button" className="btn-sm" onClick={() => setEditing(true)}>
              Изменить
            </button>
            <button
              type="button"
              className="btn-link"
              style={{ fontSize: 11.5, color: 'var(--danger)' }}
              disabled={deleting}
              onClick={remove}
            >
              Удалить
            </button>
          </div>
        </div>

        {empty ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Текст пуст. Нажмите «Изменить», чтобы что-то написать.
          </div>
        ) : (
          <MarkdownView nodes={renderMarkdown(forReading(detail.body), titles)} onOpenNote={onOpenNote} targets={linkTargets(detail)} />
        )}
      </div>
    );
  }

  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <input
          style={{ ...control, flex: 1, minWidth: 0, fontSize: 14, fontWeight: 650 }}
          value={path}
          placeholder="Товары/Новая заметка"
          onChange={(e) => setPath(e.target.value)}
          autoFocus={isNew}
        />
        <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
          <button type="button" className="btn-sm" disabled={saving || path.trim() === ''} onClick={save}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button type="button" className="btn-link" style={{ fontSize: 11.5 }} onClick={cancelEdit}>
            Отмена
          </button>
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <textarea
          ref={textareaRef}
          style={{ ...control, minHeight: 380, resize: 'vertical', lineHeight: 1.55, fontFamily: "'JetBrains Mono', monospace" }}
          value={body}
          placeholder={'Текст заметки. «[[» предложит название другой заметки.'}
          onChange={(e) => {
            setBody(e.target.value);
            updateSuggest(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => updateSuggest(body, e.currentTarget.selectionStart)}
          onBlur={() => setSuggest(null)}
        />
        {suggest && (
          <div
            className="card"
            style={{ position: 'absolute', left: 12, top: 12, zIndex: 5, minWidth: 220, maxHeight: 190, overflowY: 'auto', padding: 4 }}
          >
            {matches.length === 0 ? (
              <div style={{ padding: '7px 10px', fontSize: 11.5, color: 'var(--text-dim)' }}>Совпадений нет</div>
            ) : (
              matches.map((title) => (
                <button
                  key={title}
                  type="button"
                  className="btn-quiet"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 6 }}
                  // `onMouseDown`, not `onClick`: a click fires after the textarea's own
                  // `onBlur`, which would already have cleared `suggest` and taken the
                  // dropdown away before the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertTitle(title);
                  }}
                >
                  {title}
                </button>
              ))
            )}
          </div>
        )}
        {dirty && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>Есть несохранённые правки.</div>
        )}
      </div>
    </div>
  );
}
