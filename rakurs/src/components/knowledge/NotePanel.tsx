import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import { pluralRu } from '@/lib/training-state';
import { groupSources } from './note-sources';
import type { KbLinkRef, KbNoteDetail, KbSection } from '@/types';

/**
 * The right pane: what points at this note, what it points at, where its text came from, and
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

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** Source rows shown before «Показать все»: enough to see what backs the note, not a wall. */
const SOURCES_SHOWN = 3;

export function NotePanel({
  agentId,
  detail,
  onOpenNote,
}: {
  agentId: string;
  detail: KbNoteDetail;
  onOpenNote: (noteId: string) => void;
}) {
  const hasLinks = detail.backlinks.length > 0 || detail.links.length > 0;
  return (
    <div className="knowledge-context__stack">
      <Card>
        <CardHead title="Связи" gap={10} />
        {hasLinks ? (
          <>
            {detail.backlinks.length > 0 && (
              <LinkSection title="Ссылаются сюда" items={detail.backlinks} onOpenNote={onOpenNote} />
            )}
            {detail.links.length > 0 && (
              <LinkSection title="Ссылки из заметки" items={detail.links} onOpenNote={onOpenNote} />
            )}
          </>
        ) : (
          <p className="knowledge-context__hint">
            Заметка ни с чем не связана. Напишите в тексте «[[Название]]» другой заметки — ссылка
            появится здесь и линией в графе.
          </p>
        )}
      </Card>

      <Card>
        <CardHead title="Откуда взято" gap={10} />
        <NoteOrigin detail={detail} />
      </Card>

      <Card>
        <CardHead title="Что найдёт агент" gap={10} />
        <AgentSearch agentId={agentId} onOpenNote={onOpenNote} />
      </Card>
    </div>
  );
}

function NoteOrigin({ detail }: { detail: KbNoteDetail }) {
  const [all, setAll] = useState(false);
  const groups = useMemo(() => groupSources(detail.generationSources ?? []), [detail.generationSources]);

  if (groups.length === 0) {
    return (
      <p className="knowledge-context__hint">
        {detail.sourceTitle ? `Источник: ${detail.sourceTitle}` : 'Добавлено вручную.'}
      </p>
    );
  }

  const messages = groups.reduce((sum, group) => sum + group.count, 0);
  const shown = all ? groups : groups.slice(0, SOURCES_SHOWN);
  return (
    <>
      <p className="knowledge-context__hint">
        {messages} {pluralRu(messages, 'сообщение', 'сообщения', 'сообщений')} из WhatsApp
        {groups.length < messages && ` · ${groups.length} ${pluralRu(groups.length, 'разный текст', 'разных текста', 'разных текстов')}`}
      </p>
      <ul className="knowledge-sources">
        {shown.map((group) => {
          const date = new Date(group.latestAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          const body = (
            <>
              <span className="knowledge-sources__meta">
                {date}
                {group.count > 1 && <span className="knowledge-sources__count">×{group.count}</span>}
              </span>
              <span className="knowledge-sources__text">{group.excerpt ?? 'Сообщение без текста'}</span>
            </>
          );
          return (
            <li key={group.key}>
              {group.open ? (
                <Link
                  className="knowledge-sources__row"
                  title="Открыть в диалогах"
                  to={`../dialogs?conversation=${encodeURIComponent(group.open.conversationId)}&message=${encodeURIComponent(group.open.messageId)}`}
                >
                  {body}
                </Link>
              ) : (
                <div className="knowledge-sources__row is-unavailable" title="Диалог больше недоступен">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {groups.length > SOURCES_SHOWN && (
        <button type="button" className="btn-link knowledge-sources__more" onClick={() => setAll(!all)}>
          {all ? 'Свернуть' : `Показать все (${groups.length})`}
        </button>
      )}
    </>
  );
}

/** A row of resolved and broken links, shared between backlinks and outgoing links. */
function LinkSection({
  title,
  items,
  onOpenNote,
}: {
  title: string;
  items: KbLinkRef[];
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <div className="knowledge-links">
      <div className="eyebrow-sm">{title}</div>
      <ul>
        {items.map((item, i) => {
          const noteId = item.noteId;
          return (
            <li key={`${noteId ?? item.title}-${i}`}>
              {noteId ? (
                <button type="button" className="knowledge-links__item" onClick={() => onOpenNote(noteId)}>
                  {item.title}
                </button>
              ) : (
                // No `noteId` is not a loading state — it is the point of showing this row at
                // all: a link the agent's answer would name and then have nothing behind.
                <span className="knowledge-links__item is-broken" title="В базе нет заметки с таким названием">
                  {item.title} · заметки нет
                </span>
              )}
            </li>
          );
        })}
      </ul>
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
