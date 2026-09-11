import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import type { KbLinkRef, KbNoteDetail, KbSection } from '@/types';

/**
 * The right pane: what points at this note, what it points at, its tags and its source, and
 * the owner's own honest test of what the agent would find for a customer's question.
 *
 * That last box calls the exact route stage 5's agent calls (`GET /search`), the same way
 * the left pane's search box does — an owner testing anything else would be testing a
 * search the agent never runs.
 */

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

const tagChip: CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 6,
  background: 'var(--sunken-2)',
  border: '1px solid var(--line)',
  color: 'var(--text-3)',
};

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export function NotePanel({
  agentId,
  detail,
  onOpenNote,
}: {
  agentId: string;
  detail: KbNoteDetail;
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <CardHead title="Ссылки" gap={10} />
        <LinkSection
          title="Ссылаются сюда"
          empty="Пока никто не ссылается."
          items={detail.backlinks}
          onOpenNote={onOpenNote}
        />
        <div style={{ height: 14 }} />
        <LinkSection
          title="Ссылки из заметки"
          empty="Заметка ни на что не ссылается."
          items={detail.links}
          onOpenNote={onOpenNote}
        />
      </Card>

      <Card>
        <CardHead title="Теги и источник" gap={10} />
        {detail.tags.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Тегов нет.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {detail.tags.map((tag) => (
              <span key={tag} style={tagChip}>
                #{tag}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 10 }}>
          {(detail.generationSources?.length ?? 0) > 0
            ? 'Из диалогов WhatsApp'
            : detail.sourceTitle ? `Источник: ${detail.sourceTitle}` : 'Добавлено вручную'}
        </div>
        {(detail.generationSources?.length ?? 0) > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.generationSources!.map((source) => source.available ? (
              <Link key={source.messageId} className="btn-link" to={`../dialogs?conversation=${encodeURIComponent(source.conversationId)}&message=${encodeURIComponent(source.messageId)}`}>
                Диалог · {new Date(source.sentAt).toLocaleDateString('ru-RU')}{source.excerpt ? ` · ${preview(source.excerpt)}` : ''}
              </Link>
            ) : (
              <span key={source.messageId} style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                Источник недоступен
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Что найдёт агент" gap={10} />
        <AgentSearch agentId={agentId} onOpenNote={onOpenNote} />
      </Card>
    </div>
  );
}

/** A row of resolved and broken links, shared between backlinks and outgoing links. */
function LinkSection({
  title,
  empty,
  items,
  onOpenNote,
}: {
  title: string;
  empty: string;
  items: KbLinkRef[];
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <div>
      <div className="eyebrow-sm" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.map((item, i) => {
            const noteId = item.noteId;
            return noteId ? (
              <button
                key={`${noteId}-${i}`}
                type="button"
                className="btn-link"
                style={{ fontSize: 12, textAlign: 'left' }}
                onClick={() => onOpenNote(noteId)}
              >
                {item.title}
              </button>
            ) : (
              // No `noteId` is not a loading state — it is the point of showing this row at
              // all: a link the agent's answer would name and then have nothing behind.
              <span key={`${item.title}-${i}`} title="В базе нет заметки с таким названием" style={{ fontSize: 12, color: 'var(--danger)' }}>
                {item.title} · заметки нет
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentSearch({
  agentId,
  onOpenNote,
}: {
  agentId: string;
  onOpenNote: (noteId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query).trim();

  const result = useApi<KbSection[]>(
    (signal) => (q === '' ? Promise.resolve([]) : api.searchKb(agentId, q, signal)),
    [agentId, q],
  );

  return (
    <div>
      <input
        value={query}
        type="search"
        aria-label="Что найдёт агент"
        placeholder="Вопрос клиента"
        onChange={(e) => setQuery(e.target.value)}
        style={control}
      />
      <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '7px 0 10px' }}>
        Тот же поиск, которым отвечает ИИ.
      </div>

      {q !== '' && (
        <Async state={result} skeleton={<Skeleton height={60} />} compactError>
          {(sections) =>
            sections.length === 0 ? (
              <EmptyState>По запросу «{q}» ничего не нашлось. ИИ ответил бы так же.</EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="sunken-box"
                    style={{ textAlign: 'left', padding: '9px 11px', border: '1px solid var(--line)', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                    onClick={() => onOpenNote(section.noteId)}
                  >
                    <div className="ellipsis" style={{ fontSize: 12, fontWeight: 600 }}>
                      {section.title}
                    </div>
                    <div className="ellipsis" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                      {preview(section.content)}
                    </div>
                  </button>
                ))}
              </div>
            )
          }
        </Async>
      )}
    </div>
  );
}
