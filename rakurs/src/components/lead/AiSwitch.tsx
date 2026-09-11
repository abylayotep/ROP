import { useState } from 'react';
import * as api from '@/api';
import { Toggle } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';

/**
 * «ИИ отвечает в этом диалоге».
 *
 * One thread, not the agent: the operator who sees the agent go wrong on one conversation
 * has to be able to stop it there without taking the agent off every other conversation in
 * the cabinet. It also goes off by itself when the agent hands a thread over, which is why
 * the switch shows what the server stored rather than what was clicked.
 *
 * It appears twice on the same screen — in the lead card and above the messages — because
 * an operator deciding to step in is sometimes looking at one and sometimes at the other.
 * `compact` is the version for the thread header: no paragraph, no room for one.
 */
export function AiSwitch({
  agentId,
  conversationId,
  on,
  onSet,
  onFailed,
  compact = false,
}: {
  agentId: string;
  conversationId: string;
  on: boolean;
  onSet: (aiEnabled: boolean) => void;
  onFailed: () => void;
  compact?: boolean;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  async function toggle() {
    if (saving) return;
    setSaving(true);
    try {
      // The route answers with the flag as stored, and that is what goes on screen: a
      // switch showing what was clicked would claim a change the server refused.
      const { aiEnabled } = await api.setConversationAi(agentId, conversationId, !on);
      onSet(aiEnabled);
    } catch (error) {
      toast.fail(error);
      onFailed();
    } finally {
      setSaving(false);
    }
  }

  const control = (
    <button
      type="button"
      className="btn-quiet"
      aria-pressed={on}
      aria-label="ИИ отвечает в этом диалоге"
      disabled={saving}
      style={{ marginLeft: 'auto', display: 'flex', opacity: saving ? 0.5 : 1 }}
      onClick={toggle}
    >
      <Toggle on={on} />
    </button>
  );

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
        <span style={{ fontSize: 11.5, color: on ? 'var(--text-dim)' : 'var(--danger)' }}>
          {on ? 'Отвечает ИИ' : 'Отвечает человек'}
        </span>
        {control}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 650 }}>ИИ отвечает в этом диалоге</span>
        {control}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5, lineHeight: 1.45 }}>
        {on
          ? 'Выключите — и диалог останется человеку. Другие диалоги это не затронет.'
          : 'Отвечает человек. Другие диалоги агент ведёт как вёл.'}
      </div>
    </div>
  );
}
