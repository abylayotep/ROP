/**
 * State the «Обучение агента» section derives rather than stores: the generation wizard's
 * step, the one next action the strip suggests, and a draft's origin label.
 */
import type { KbDraft, KbGenerationRunDetail, KbGenerationRunError } from '@/types';

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

/** Chat-generation drafts carry `origin: 'manual'`; the server titles them «База знаний из WhatsApp»
 * and «Скрипт продаж из WhatsApp» (`server/src/lib/knowledge/whatsapp-drafts.ts`). Older ones
 * ended with « · N», the number of changes. */
export function draftOrigin(draft: Pick<KbDraft, 'origin' | 'title'>): DraftOriginLabel {
  if (draft.origin === 'coach') return 'Тренер';
  if (/ из WhatsApp( · \d+)?$/.test(draft.title)) return 'Из переписки';
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

export interface RunErrorSummary {
  /** `partial`: some batches failed but the run finished; `error`: the run itself failed. */
  severity: 'partial' | 'error';
  /** One line counting failed batches, or `null` when no batch failed. */
  text: string | null;
  /** Errors not tied to a batch (missing key, consolidation) — actionable, shown one by one. */
  runLevel: KbGenerationRunError[];
}

/**
 * A run that finished with a few unusable batches still produced reviewable facts. Listing
 * every batch error in red made such a run read as a crash, so batch errors collapse into one
 * count and the per-batch list moves under details. Run-level errors stay visible: each one
 * names a fix the owner has to make.
 */
export function runErrorSummary(run: {
  status: KbGenerationRunDetail['run']['status'];
  batchCount: number;
  errors: KbGenerationRunError[];
}): RunErrorSummary | null {
  if (run.errors.length === 0) return null;
  const runLevel = run.errors.filter((error) => error.ordinal === null);
  const failedBatches = new Set(run.errors.flatMap((error) => (error.ordinal === null ? [] : [error.ordinal]))).size;
  const finished = run.status === 'completed' || run.status === 'cancelled';
  const severity = finished && runLevel.length === 0 ? 'partial' : 'error';
  const count = `Не обработано частей: ${failedBatches} из ${run.batchCount}.`;
  const text = failedBatches === 0 ? null
    : severity === 'partial' ? `${count} Остальное разобрано — факты ниже можно отбирать.` : count;
  return { severity, text, runLevel };
}
