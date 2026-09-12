import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { Async, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { KbGenerationProposal, KbGenerationRunDetail } from '@/types';

const WARNING: Record<string, string> = {
  dated: 'Может быть устаревшим',
  conflict: 'Есть противоречие',
  context_limited: 'Не хватает контекста',
};

export function GenerationReview({
  agentId,
  detail,
  onChanged,
  readOnly = false,
}: {
  agentId: string;
  detail: KbGenerationRunDetail;
  onChanged: (proposal: KbGenerationProposal) => void;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string[]>([]);
  const proposals = detail.proposals.items;
  const handleBlocked = useCallback((proposalId: string, isBlocked: boolean) => {
    setBlocked((current) => isBlocked
      ? current.includes(proposalId) ? current : [...current, proposalId]
      : current.filter((id) => id !== proposalId));
  }, []);

  useEffect(() => {
    const pending = new Set(proposals.filter((proposal) => proposal.status === 'pending').map((proposal) => proposal.id));
    setSelected((current) => current.filter((id) => pending.has(id)));
  }, [proposals]);

  async function makeDraft() {
    const chosen = proposals.filter((proposal) => selected.includes(proposal.id));
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      const result = await api.createKnowledgeGenerationDraft(agentId, detail.run.id, {
        proposalIds: chosen.map((proposal) => proposal.id),
        revisions: Object.fromEntries(chosen.map((proposal) => [proposal.id, proposal.revision])),
        updateTargets: Object.fromEntries(
          chosen.flatMap((proposal) => targets[proposal.id] ? [[proposal.id, targets[proposal.id]]] : []),
        ),
      });
      navigate(`../drafts/${result.draftId}`);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  if (proposals.length === 0) {
    return <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>Подходящих фактов не найдено. Ничего не опубликовано.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        {readOnly ? 'Предложения и источники доступны только для просмотра.' : 'Ничего не выбрано автоматически. Проверьте формулировки и источники.'}
      </div>
      {proposals.map((proposal) => (
        <ProposalCard
          key={`${proposal.id}:${proposal.revision}`}
          agentId={agentId}
          proposal={proposal}
          selected={selected.includes(proposal.id)}
          selectionFull={selected.length >= 20}
          target={targets[proposal.id] ?? ''}
          onSelect={(checked) => setSelected((current) => checked ? [...current, proposal.id].slice(0, 20) : current.filter((id) => id !== proposal.id))}
          onTarget={(noteId) => setTargets((current) => ({ ...current, [proposal.id]: noteId }))}
          onChanged={onChanged}
          onBlocked={handleBlocked}
          readOnly={readOnly}
        />
      ))}
      {!readOnly && <button type="button" className="btn" disabled={busy || selected.length === 0 || selected.some((id) => blocked.includes(id))} onClick={() => void makeDraft()}>
        {busy ? 'Создаём черновик…' : `Создать черновик · ${selected.length}`}
      </button>}
    </div>
  );
}

function ProposalCard({
  agentId,
  proposal,
  selected,
  selectionFull,
  target,
  onSelect,
  onTarget,
  onChanged,
  onBlocked,
  readOnly,
}: {
  agentId: string;
  proposal: KbGenerationProposal;
  selected: boolean;
  selectionFull: boolean;
  target: string;
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

  async function update(values: { path?: string; body?: string; status?: 'pending' | 'rejected' }) {
    setBusy(true);
    try {
      const updated = await api.updateKnowledgeGenerationProposal(agentId, proposal.id, {
        revision: proposal.revision,
        ...values,
      });
      onChanged(updated);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      {!readOnly && proposal.status === 'pending' && <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 650 }}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!editable || (!selected && selectionFull)}
          onChange={(event) => onSelect(event.target.checked)}
        />
        Добавить в черновик
      </label>}
      {proposal.status === 'drafted' && proposal.draftId && <Link className="btn-link" to={`../drafts/${proposal.draftId}`}>В черновике →</Link>}
      {proposal.status === 'applied' && proposal.noteId && <Link className="btn-link" to={`?note=${encodeURIComponent(proposal.noteId)}`}>Опубликовано в заметке →</Link>}
      {proposal.status === 'rejected' && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Отклонено</div>}
      <input aria-label="Путь заметки" value={path} disabled={!editable} onChange={(event) => setPath(event.target.value)} style={{ width: '100%', marginTop: 10 }} />
      <textarea aria-label="Текст предложения" value={body} disabled={!editable} onChange={(event) => setBody(event.target.value)} rows={5} style={{ width: '100%', marginTop: 8 }} />
      {proposal.warnings.length > 0 && (
        <div style={{ color: 'var(--warning)', fontSize: 12, marginTop: 6 }}>
          {proposal.warnings.map((warning) => WARNING[warning] ?? warning).join(' · ')}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {proposal.sources.map((source) => source.available ? (
          <Link key={source.messageId} className="btn-link" to={`../dialogs?conversation=${encodeURIComponent(source.conversationId)}&message=${encodeURIComponent(source.messageId)}`}>
            Источник · {new Date(source.sentAt).toLocaleDateString('ru-RU')}
          </Link>
        ) : <span key={source.messageId} style={{ color: 'var(--text-dim)', fontSize: 12 }}>Источник недоступен</span>)}
      </div>
      {proposal.sources.some((source) => source.excerpt) && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>
          {proposal.sources.map((source) => source.excerpt).filter(Boolean).join(' · ')}
        </div>
      )}
      {proposal.matches.length > 0 && (
        <label style={{ display: 'block', fontSize: 12, marginTop: 10 }}>
          Существующая заметка
          <select value={target} disabled={!editable} onChange={(event) => onTarget(event.target.value)} style={{ width: '100%', marginTop: 4 }}>
            <option value="">Создать новую</option>
            {proposal.matches.map((match) => <option key={match.noteId} value={match.noteId}>{match.path}{match.exact ? ' · точное совпадение' : ''}</option>)}
          </select>
        </label>
      )}
      {target && <ExistingNote agentId={agentId} noteId={target} />}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {editable && <button type="button" className="btn-sm" disabled={busy || !dirty} onClick={() => void update({ path, body })}>Сохранить правки</button>}
        {!readOnly && (proposal.status === 'pending' || rejected) && <button type="button" className="btn-sm" disabled={busy} onClick={() => void update({ status: rejected ? 'pending' : 'rejected' })}>
          {rejected ? 'Вернуть на проверку' : 'Отклонить'}
        </button>}
      </div>
    </Card>
  );
}

function ExistingNote({ agentId, noteId }: { agentId: string; noteId: string }) {
  const note = useApi((signal) => api.getKbNote(agentId, noteId, signal), [agentId, noteId]);
  return (
    <Async state={note} skeleton={<Skeleton height={50} />} compactError>
      {(loaded) => <div className="sunken-box" style={{ marginTop: 8, padding: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>Сейчас в заметке:<br />{loaded.body}</div>}
    </Async>
  );
}
