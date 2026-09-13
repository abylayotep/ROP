import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '@/api';
import { useToast } from '@/components/ui/Toast';
import { ruleCategoryPhrase } from '@/lib/rule-categories';
import type { AgentRule, CoachMessage, CoachProposal } from '@/types';
import { ApiError } from '@/api/client';
import { needsProposalReconciliation, proposalWithText } from './proposal';

/**
 * What a coaching turn proposed, and the two answers an owner may give it today.
 *
 * `POST …/messages/:id/draft` (`server/src/api/coach.ts` and `server/src/api/drafts.ts`) is
 * what turns a proposal into a draft, and «В черновик» calls it and sends the owner straight
 * to `DraftScreen` to read «было — стало» and decide. «Отклонить» needs nothing beyond it —
 * it was live before this and stays exactly as it was.
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
  lineHeight: 1.5,
  outline: 'none',
  resize: 'vertical',
};

/**
 * The one-liner a card shows above its text, and the text itself.
 *
 * A `rule_edit` and a `note_edit` name the record they touch rather than repeat it: the
 * owner is looking at the rule or note already (`rules` is the whole list this agent has),
 * so quoting its current text is what lets them tell two coaching turns about two different
 * rules apart at a glance. A `note_edit` cannot do the same — this function is handed rules,
 * never notes — so it names the action and nothing more.
 */
export function describeProposal(
  proposal: CoachProposal,
  rules: AgentRule[],
): { title: string; body: string } {
  switch (proposal.kind) {
    case 'rule':
      return {
        title: `Новое правило: ${ruleCategoryPhrase(proposal.category)}`,
        body: proposal.text,
      };

    case 'rule_edit': {
      const rule = rules.find((item) => item.id === proposal.ruleId);
      const named = rule ? ` «${rule.text}»` : '';
      const body = proposal.text ?? rule?.text ?? '';
      if (proposal.enabled === false) return { title: `Выключить правило${named}`, body };
      if (proposal.enabled === true) return { title: `Включить правило${named}`, body };
      return { title: `Правка правила${named}`, body };
    }

    case 'note':
      return { title: `Новая заметка «${proposal.path}»`, body: proposal.body };

    case 'note_edit':
      return { title: 'Правка заметки', body: proposal.body };
  }
}

export function ProposalCard({
  agentId,
  message,
  rules,
  onRejected,
}: {
  agentId: string;
  /** The model line this card sits under. Only ever called with `message.proposal !== null`. */
  message: CoachMessage;
  rules: AgentRule[];
  onRejected: (updated: CoachMessage) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const proposal = message.proposal!;
  const described = useMemo(() => describeProposal(proposal, rules), [proposal, rules]);

  const [text, setText] = useState(described.body);
  const [savedMessage, setSavedMessage] = useState(message);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const decided = savedMessage.status !== 'pending';
  const dirty = text !== describeProposal(savedMessage.proposal ?? proposal, rules).body;
  const draftAllowed = !decided && !dirty && !saving && !drafting && !conflict;

  async function save() {
    if (saving || decided || !dirty) return;
    setSaving(true);
    try {
      const updated = await api.updateCoachProposal(agentId, message.id, savedMessage.revision ?? 1, proposalWithText(savedMessage.proposal ?? proposal, text));
      setSavedMessage(updated);
      setConflict(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = (await api.listCoachMessages(agentId)).find((item) => item.id === message.id);
          if (latest) {
            setSavedMessage(latest);
            setConflict(needsProposalReconciliation(text, describeProposal(latest.proposal ?? proposal, rules).body));
          } else setConflict(true);
        } catch (reloadError) {
          toast.fail(reloadError);
          setConflict(true);
        }
      } else toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function reject() {
    if (rejecting || decided) return;
    setRejecting(true);
    try {
      const updated = await api.rejectCoachMessage(agentId, message.id);
      setSavedMessage(updated);
      onRejected(updated);
    } catch (error) {
      toast.fail(error);
    } finally {
      setRejecting(false);
    }
  }

  async function toDraft() {
    if (!draftAllowed) return;
    setDrafting(true);
    try {
      const draft = await api.draftCoachMessage(agentId, message.id, savedMessage.revision ?? 1);
      navigate(`../drafts/${draft.id}`);
    } catch (error) {
      toast.fail(error);
      setDrafting(false);
    }
  }

  return (
    <div
      className="card"
      style={{ maxWidth: '85%', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 650 }}>{described.title}</div>

      {message.warning && (
        <div style={{ fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.45 }}>{message.warning}</div>
      )}

      <textarea
        style={{ ...control, minHeight: 64 }}
        value={text}
        disabled={decided}
        onChange={(e) => setText(e.target.value)}
      />

      {conflict && dirty && <div role="alert" style={{ fontSize: 11.5, color: 'var(--warn)' }}>Предложение изменилось. Ваш текст сохранён в поле; проверьте его и сохраните снова.</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="btn-sm" disabled={saving || !dirty || decided} onClick={() => void save()}>
          {saving ? 'Сохраняем…' : 'Сохранить правку'}
        </button>
        <button type="button" className="btn-sm" disabled={!draftAllowed} onClick={() => void toDraft()}>
          {drafting ? 'Открываем…' : 'В черновик'}
        </button>
        <button type="button" className="btn-sm" disabled={rejecting || decided} onClick={reject}>
          {savedMessage.status === 'rejected' ? 'Отклонено' : rejecting ? 'Отклоняем…' : 'Отклонить'}
        </button>
        {savedMessage.status === 'drafted' && savedMessage.draftId && (
          <button
            type="button"
            className="btn-link"
            style={{ fontSize: 11, color: 'var(--text-dim)' }}
            onClick={() => navigate(`../drafts/${savedMessage.draftId}`)}
          >
            В черновиках →
          </button>
        )}
      </div>
    </div>
  );
}
