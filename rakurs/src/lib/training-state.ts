/**
 * State the «Обучение агента» section derives rather than stores: the generation wizard's
 * step, the one next action the strip suggests, and a draft's origin label.
 */
import type { KbDraft, KbGenerationRunDetail } from '@/types';

export type WizardStep = 'period' | 'processing' | 'selection' | 'draft';

/**
 * A failed or cancelled run that found nothing stays on «Разбор» with its error; one that
 * found something can still be reviewed. A completed run with zero proposals is «Отбор»,
 * whose empty state says nothing new was found.
 */
export function wizardStep(
  detail: {
    run: { status: KbGenerationRunDetail['run']['status']; proposalCount: number };
    drafts: { id: string }[];
  } | null,
  pickMore: boolean,
): WizardStep {
  if (detail === null) return 'period';
  const { status, proposalCount } = detail.run;
  if (status === 'queued' || status === 'running') return 'processing';
  if ((status === 'failed' || status === 'cancelled') && proposalCount === 0) return 'processing';
  return detail.drafts.length > 0 && !pickMore ? 'draft' : 'selection';
}

export type NextStep =
  | { kind: 'running'; percent: number; runId: string }
  | { kind: 'review'; count: number }
  | { kind: 'empty' }
  | null;

export function nextStep(input: {
  owner: boolean;
  activeRun: { id: string; completedBatchCount: number; batchCount: number } | null;
  openDrafts: number;
  noteCount: number | null;
}): NextStep {
  if (!input.owner) return null;
  const { activeRun } = input;
  if (activeRun) {
    const percent = activeRun.batchCount > 0
      ? Math.floor((activeRun.completedBatchCount * 100) / activeRun.batchCount)
      : 0;
    return { kind: 'running', percent, runId: activeRun.id };
  }
  if (input.openDrafts > 0) return { kind: 'review', count: input.openDrafts };
  if (input.noteCount === 0) return { kind: 'empty' };
  return null;
}

export type DraftOriginLabel = 'Тренер' | 'Из переписки' | 'Вручную';

/** Chat-generation drafts carry `origin: 'manual'`; the server titles them «… из WhatsApp»
 * (`draftKinds` in `server/src/lib/knowledge/generation-review.ts`). */
export function draftOrigin(draft: Pick<KbDraft, 'origin' | 'title'>): DraftOriginLabel {
  if (draft.origin === 'coach') return 'Тренер';
  if (draft.title.endsWith(' из WhatsApp')) return 'Из переписки';
  return 'Вручную';
}

/** Russian plural form for a count: 1 черновик, 3 черновика, 5 черновиков, 21 черновик. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Roving tab focus for a WAI-ARIA tablist: arrows wrap, Home and End jump. */
export function tabAfterKey<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  const index = ids.indexOf(current);
  if (index < 0 || ids.length === 0) return null;
  if (key === 'Home') return ids[0]!;
  if (key === 'End') return ids[ids.length - 1]!;
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length]!;
  if (key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length]!;
  return null;
}
