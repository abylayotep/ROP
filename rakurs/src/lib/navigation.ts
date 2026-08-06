import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '@/store/app-state';
import type { DialogFilter, InsightTarget } from '@/types';

/**
 * Переходы с контекстом: выводы на обзоре и кнопки в разборах меняют раздел
 * вместе с фильтром, чтобы пользователь попадал сразу на нужные строки,
 * а не на общий список.
 */
export function useContextNavigation() {
  const navigate = useNavigate();
  const { patch } = useAppState();

  /** Открыть разбор конкретного объявления. */
  const openCreative = useCallback(
    (name: string) => {
      patch({ selCr: name, creative: null });
      navigate('/creatives');
    },
    [navigate, patch]
  );

  /** Открыть диалоги с уже применённым фильтром. */
  const openDialogs = useCallback(
    (opts: { filter?: DialogFilter; creative?: string | null } = {}) => {
      patch({ filter: opts.filter ?? 'all', creative: opts.creative ?? null, panel: 'chat' });
      navigate('/dialogs');
    },
    [navigate, patch]
  );

  /** Переход по цели, которую прислал бэкенд вместе с выводом. */
  const openInsight = useCallback(
    (target: InsightTarget) => {
      if (target.screen === 'creative' && target.creative) return openCreative(target.creative);
      if (target.screen === 'dialogs') return openDialogs({ filter: target.filter });
      if (target.screen === 'sellers') return navigate('/sellers');
      if (target.screen === 'broadcast') return navigate('/broadcast');
    },
    [navigate, openCreative, openDialogs]
  );

  return { navigate, openCreative, openDialogs, openInsight };
}
