import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { useToast } from '@/components/ui/Toast';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type {
  KbGenerationProposal,
  KbGenerationProposalKind,
  KbGenerationRunDetail,
} from '@/types';

const WARNING: Record<string, string> = {
  dated: 'Может быть устаревшим',
  conflict: 'Есть противоречие',
  context_limited: 'Не хватает контекста',
};

const CLASSIFICATION: Record<string, string> = {
  irrelevant: 'Не относится к клиентам',
  uncertain: 'Недостаточно данных',
};

type ProposalUpdate = typeof api.updateKnowledgeGenerationProposal;
type ProposalPatch = { path?: string; body?: string; status?: 'pending' | 'rejected' };
type DraftCreate = typeof api.createKnowledgeGenerationDraft;

export const patchGenerationProposal = (
  agentId: string,
  proposal: KbGenerationProposal,
  values: ProposalPatch,
  update: ProposalUpdate = api.updateKnowledgeGenerationProposal,
) => update(agentId, proposal.id, { revision: proposal.revision, ...values });

export function createDraftFromPersistedSelection(
  agentId: string,
  runId: string,
  proposals: readonly KbGenerationProposal[],
  targets: Readonly<Record<string, string>>,
  create: DraftCreate = api.createKnowledgeGenerationDraft,
) {
  const chosen = proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected);
  if (chosen.length === 0) return Promise.resolve(null);
  return create(agentId, runId, {
    proposalIds: chosen.map((proposal) => proposal.id),
    revisions: Object.fromEntries(chosen.map((proposal) => [proposal.id, proposal.revision])),
    updateTargets: Object.fromEntries(
      chosen.flatMap((proposal) => targets[proposal.id] ? [[proposal.id, targets[proposal.id]!]] : []),
    ),
  });
}

export async function persistProposalSelection({
  agentId,
  proposal,
  selected,
  update = api.updateKnowledgeGenerationProposal,
  onOptimistic,
  onCommitted,
  onRollback,
}: {
  agentId: string;
  proposal: KbGenerationProposal;
  selected: boolean;
  update?: ProposalUpdate;
  onOptimistic: (proposal: KbGenerationProposal) => void;
  onCommitted: (proposal: KbGenerationProposal) => void;
  onRollback: (proposal: KbGenerationProposal) => void;
}): Promise<KbGenerationProposal> {
  onOptimistic({ ...proposal, selected });
  try {
    const committed = await update(agentId, proposal.id, { revision: proposal.revision, selected });
    onCommitted(committed);
    return committed;
  } catch (error) {
    onRollback(proposal);
    throw error;
  }
}

export function ProposalWorkspace({
  agentId,
  detail,
  onChanged,
  onLoadAllProposals,
  onLoadMoreProposals,
  onLoadMoreExclusions,
  onLoadRawFindings,
  onLoadMoreRawFindings,
  readOnly = false,
}: {
  agentId: string;
  detail: KbGenerationRunDetail;
  onChanged: (proposal: KbGenerationProposal) => void;
  onLoadAllProposals?: () => Promise<KbGenerationProposal[]>;
  onLoadMoreProposals?: () => void;
  onLoadMoreExclusions?: () => void;
  onLoadRawFindings?: () => void;
  onLoadMoreRawFindings?: () => void;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [kind, setKind] = useState<KbGenerationProposalKind>('knowledge');
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [updating, setUpdating] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const proposals = detail.proposals.items;
  const visible = useMemo(() => proposals.filter((proposal) => proposal.kind === kind), [kind, proposals]);
  const selectedCount = proposals.filter((proposal) => proposal.status === 'pending' && proposal.selected).length;
  const visibleEligible = visible.filter((proposal) => proposal.status === 'pending');

  const setProposalBlocked = useCallback((proposalId: string, isBlocked: boolean) => {
    setBlocked((current) => isBlocked
      ? current.includes(proposalId) ? current : [...current, proposalId]
      : current.filter((id) => id !== proposalId));
  }, []);

  async function select(proposal: KbGenerationProposal, selected: boolean) {
    if (readOnly || proposal.status !== 'pending' || updating.includes(proposal.id)) return;
    setUpdating((current) => [...current, proposal.id]);
    try {
      await persistProposalSelection({
        agentId,
        proposal,
        selected,
        onOptimistic: onChanged,
        onCommitted: onChanged,
        onRollback: onChanged,
      });
    } catch (error) {
      toast.fail(error, 'Не удалось сохранить выбор. Предыдущее состояние восстановлено.');
    } finally {
      setUpdating((current) => current.filter((id) => id !== proposal.id));
    }
  }

  async function setVisibleSelection(selected: boolean) {
    const changes = visibleEligible.filter((proposal) => proposal.selected !== selected);
    await Promise.all(changes.map((proposal) => select(proposal, selected)));
  }

  async function makeDraft() {
    if (readOnly || drafting || blocked.length > 0 || updating.length > 0) return;
    setDrafting(true);
    try {
      const complete = onLoadAllProposals ? await onLoadAllProposals() : proposals;
      const result = await createDraftFromPersistedSelection(agentId, detail.run.id, complete, targets);
      if (!result) return;
      navigate(`../drafts/${result.draftId}`);
    } catch (error) {
      toast.fail(error);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <section className="proposal-workspace" aria-label="Предложения запуска">
      <header className="proposal-workspace__header">
        <div>
          <p className="knowledge-kicker">Проверка предложений</p>
          <h2>{kind === 'knowledge' ? 'База знаний' : 'Скрипт продаж'}</h2>
        </div>
        <span className="proposal-workspace__selection">Выбрано <b>{selectedCount}</b></span>
      </header>

      <nav className="proposal-kind-tabs" role="tablist" aria-label="Тип предложений">
        {([
          ['knowledge', 'База знаний'],
          ['script', 'Скрипт продаж'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={kind === id}
            onClick={() => setKind(id)}
          >
            <span>{label}</span>
            <b>{proposals.filter((proposal) => proposal.kind === id).length}</b>
          </button>
        ))}
      </nav>

      {!readOnly && visibleEligible.length > 0 && (
        <div className="proposal-workspace__bulk" aria-label="Групповой выбор">
          <button type="button" className="btn-link" disabled={updating.length > 0} onClick={() => void setVisibleSelection(true)}>
            Выбрать видимые
          </button>
          <button type="button" className="btn-link" disabled={updating.length > 0} onClick={() => void setVisibleSelection(false)}>
            Очистить выбор
          </button>
          <span>Выбор сохраняется сразу</span>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="knowledge-inline-state proposal-workspace__empty">
          <p>{kind === 'knowledge' ? 'Новых фактов для базы знаний нет.' : 'Новых фраз для скрипта продаж нет.'}</p>
          <span>Ничего не опубликовано автоматически.</span>
        </div>
      ) : (
        <div className="proposal-list">
          {visible.map((proposal) => (
            <ProposalCard
              key={`${proposal.id}:${proposal.revision}`}
              agentId={agentId}
              proposal={proposal}
              target={targets[proposal.id] ?? ''}
              updating={updating.includes(proposal.id)}
              onSelect={(selected) => void select(proposal, selected)}
              onTarget={(noteId) => setTargets((current) => ({ ...current, [proposal.id]: noteId }))}
              onChanged={onChanged}
              onBlocked={setProposalBlocked}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}

      {detail.proposals.nextCursor && onLoadMoreProposals && (
        <button type="button" className="knowledge-load-more" onClick={onLoadMoreProposals}>Показать ещё предложения</button>
      )}

      {!readOnly && (
        <footer className="proposal-workspace__footer">
          <div>
            <b>Ничего не публикуется сразу</b>
            <span>Сначала откроется отдельный черновик для финальной проверки.</span>
          </div>
          <button
            type="button"
            className="btn-accent"
            disabled={drafting || (selectedCount === 0 && detail.proposals.nextCursor === null) || blocked.length > 0 || updating.length > 0}
            onClick={() => void makeDraft()}
          >
            {drafting ? 'Собираем…' : selectedCount > 0 ? `Собрать новый черновик · ${selectedCount}` : 'Собрать новый черновик'}
          </button>
        </footer>
      )}

      <AuditSection
        detail={detail}
        onLoadMoreExclusions={onLoadMoreExclusions}
        onLoadRawFindings={onLoadRawFindings}
        onLoadMoreRawFindings={onLoadMoreRawFindings}
      />
    </section>
  );
}

function ProposalCard({
  agentId,
  proposal,
  target,
  updating,
  onSelect,
  onTarget,
  onChanged,
  onBlocked,
  readOnly,
}: {
  agentId: string;
  proposal: KbGenerationProposal;
  target: string;
  updating: boolean;
  onSelect: (selected: boolean) => void;
  onTarget: (noteId: string) => void;
  onChanged: (proposal: KbGenerationProposal) => void;
  onBlocked: (proposalId: string, blocked: boolean) => void;
  readOnly: boolean;
}) {
  const toast = useToast();
  const [path, setPath] = useState(proposal.path);
  const [body, setBody] = useState(proposal.body);
  const [busy, setBusy] = useState(false);
  const rejected = proposal.status === 'rejected';
  const editable = proposal.status === 'pending' && !readOnly;
  const dirty = path !== proposal.path || body !== proposal.body;

  useEffect(() => onBlocked(proposal.id, dirty || busy), [proposal.id, dirty, busy, onBlocked]);

  async function update(values: ProposalPatch) {
    setBusy(true);
    try {
      const updated = await patchGenerationProposal(agentId, proposal, values);
      onChanged(updated);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`proposal-card proposal-card--${proposal.status}`}>
      <header className="proposal-card__header">
        <div className="proposal-card__state">
          {!readOnly && proposal.status === 'pending' && (
            <label className="proposal-card__check">
              <input
                type="checkbox"
                aria-label={`Добавить ${proposal.path} в черновик`}
                checked={proposal.selected}
                disabled={!editable || updating}
                onChange={(event) => onSelect(event.target.checked)}
              />
              <span>{updating ? 'Сохраняем…' : 'Добавить'}</span>
            </label>
          )}
          {proposal.confidence === 'high' && proposal.status === 'pending' && <span className="proposal-confidence">Проверено источниками</span>}
          {proposal.status === 'drafted' && proposal.draftId && <Link className="btn-link" to={`../drafts/${proposal.draftId}`}>В черновике →</Link>}
          {proposal.status === 'applied' && proposal.noteId && <Link className="btn-link" to={`?note=${encodeURIComponent(proposal.noteId)}`}>Опубликовано в заметке →</Link>}
          {rejected && <span className="proposal-card__rejected">Отклонено</span>}
        </div>
        <span className="proposal-card__source-count">{proposal.sources.length} {sourceWord(proposal.sources.length)}</span>
      </header>

      <label className="proposal-field">
        <span>Путь</span>
        <input aria-label="Путь заметки" value={path} disabled={!editable} onChange={(event) => setPath(event.target.value)} />
      </label>
      <label className="proposal-field">
        <span>Текст</span>
        <textarea aria-label="Текст предложения" value={body} disabled={!editable} onChange={(event) => setBody(event.target.value)} rows={4} />
      </label>

      {proposal.warnings.length > 0 && (
        <div className="proposal-warnings" role="note">
          {proposal.warnings.map((warning) => <span key={warning}>{WARNING[warning] ?? warning}</span>)}
        </div>
      )}

      <div className="proposal-sources" aria-label="Источники предложения">
        {proposal.sources.map((source, index) => source.available ? (
          <Link key={source.messageId} to={`../dialogs?conversation=${encodeURIComponent(source.conversationId)}&message=${encodeURIComponent(source.messageId)}`}>
            Источник {index + 1} · {new Date(source.sentAt).toLocaleDateString('ru-RU')}
          </Link>
        ) : <span key={source.messageId}>Источник {index + 1} недоступен</span>)}
      </div>
      {proposal.sources.some((source) => source.excerpt) && (
        <details className="proposal-excerpts">
          <summary>Фрагменты переписки</summary>
          {proposal.sources.filter((source) => source.excerpt).map((source) => <blockquote key={source.messageId}>{source.excerpt}</blockquote>)}
        </details>
      )}

      {proposal.matches.length > 0 && (
        <label className="proposal-field proposal-field--compact">
          <span>Существующая заметка</span>
          <select value={target} disabled={!editable} onChange={(event) => onTarget(event.target.value)}>
            <option value="">Создать новую</option>
            {proposal.matches.map((match) => <option key={match.noteId} value={match.noteId}>{match.path}{match.exact ? ' · точное совпадение' : ''}</option>)}
          </select>
        </label>
      )}
      {target && <ExistingNote agentId={agentId} noteId={target} />}

      {!readOnly && (editable || rejected) && (
        <footer className="proposal-card__actions">
          {editable && <button type="button" className="btn-sm" disabled={busy || !dirty} onClick={() => void update({ path, body })}>Сохранить правки</button>}
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => void update({ status: rejected ? 'pending' : 'rejected' })}>
            {rejected ? 'Вернуть на проверку' : 'Отклонить'}
          </button>
        </footer>
      )}
    </article>
  );
}

function AuditSection({
  detail,
  onLoadMoreExclusions,
  onLoadRawFindings,
  onLoadMoreRawFindings,
}: {
  detail: KbGenerationRunDetail;
  onLoadMoreExclusions?: () => void;
  onLoadRawFindings?: () => void;
  onLoadMoreRawFindings?: () => void;
}) {
  return (
    <section className="generation-audit" aria-labelledby="generation-audit-title">
      <header>
        <p className="knowledge-kicker">Аудит</p>
        <h3 id="generation-audit-title">Исключённые пакеты</h3>
      </header>
      {detail.exclusions.length === 0 ? (
        <p className="generation-audit__empty">Исключённых пакетов на загруженной странице нет.</p>
      ) : (
        <ol className="generation-exclusions">
          {detail.exclusions.map((exclusion) => (
            <li key={exclusion.batchId}>
              <span className="mono">#{exclusion.ordinal + 1}</span>
              <div><b>{CLASSIFICATION[exclusion.classification]}</b><p>{exclusion.reason}</p></div>
            </li>
          ))}
        </ol>
      )}
      {detail.exclusionsNextCursor && onLoadMoreExclusions && (
        <button type="button" className="knowledge-load-more" onClick={onLoadMoreExclusions}>Показать ещё исключения</button>
      )}

      <details className="raw-findings">
        <summary>Исходные находки</summary>
        {detail.rawFindings === undefined ? (
          <button type="button" className="btn-sm" onClick={onLoadRawFindings}>Загрузить исходные находки</button>
        ) : detail.rawFindings.length === 0 ? (
          <p>Исходных находок нет.</p>
        ) : (
          <div className="raw-findings__list">
            {detail.rawFindings.map((finding) => (
              <article key={finding.id}>
                <b>{finding.path}</b>
                <p>{finding.body}</p>
                <span>{finding.sources.length} {sourceWord(finding.sources.length)}</span>
              </article>
            ))}
          </div>
        )}
        {detail.rawFindingsNextCursor && onLoadMoreRawFindings && (
          <button type="button" className="knowledge-load-more" onClick={onLoadMoreRawFindings}>Показать ещё находки</button>
        )}
      </details>
    </section>
  );
}

function ExistingNote({ agentId, noteId }: { agentId: string; noteId: string }) {
  const note = useApi((signal) => api.getKbNote(agentId, noteId, signal), [agentId, noteId]);
  return (
    <Async state={note} skeleton={<Skeleton height={54} />} compactError>
      {(loaded) => <div className="proposal-existing-note"><b>Сейчас в заметке</b><p>{loaded.body}</p></div>}
    </Async>
  );
}

function sourceWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'источник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'источника';
  return 'источников';
}
