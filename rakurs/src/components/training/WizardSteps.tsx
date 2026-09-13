import type { WizardStep } from '@/lib/training-state';

const STEPS: ReadonlyArray<{ id: WizardStep; label: string }> = [
  { id: 'period', label: 'Период' },
  { id: 'processing', label: 'Разбор' },
  { id: 'selection', label: 'Отбор' },
  { id: 'draft', label: 'Черновик' },
];

/**
 * The four-step indicator above the generation wizard. Display only: the step is derived.
 * `null` shows the steps without a current one — a linked run whose detail is still loading.
 */
export function WizardSteps({ current }: { current: WizardStep | null }) {
  const currentIndex = current === null ? -1 : STEPS.findIndex((step) => step.id === current);
  return (
    <ol className="training-steps" aria-label="Шаги разбора переписки">
      {STEPS.map((step, index) => (
        <li
          key={step.id}
          className={index < currentIndex ? 'training-steps__item is-done' : 'training-steps__item'}
          aria-current={index === currentIndex ? 'step' : undefined}
        >
          <span className="training-steps__number">{index + 1}</span>
          <span className="training-steps__label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
