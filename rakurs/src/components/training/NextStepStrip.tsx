import { pluralRu, type NextStep } from '@/lib/training-state';

/** The one line under the page title that names the next useful action. Owner only. */
export function NextStepStrip({ step, onOpen }: {
  step: NextStep;
  onOpen: (step: Exclude<NextStep, null>) => void;
}) {
  if (step === null) return null;
  return (
    <div className="training-strip" role="status">
      <p className="training-strip__text">{stripText(step)}</p>
      <button type="button" className="btn-sm training-strip__open" onClick={() => onOpen(step)}>Открыть</button>
    </div>
  );
}

function stripText(step: Exclude<NextStep, null>): string {
  if (step.kind === 'running') return `Идёт разбор переписки — ${step.percent}%`;
  if (step.kind === 'review') {
    const drafts = pluralRu(step.count, 'черновик', 'черновика', 'черновиков');
    const verb = pluralRu(step.count, 'ждёт', 'ждут', 'ждут');
    return `${step.count} ${drafts} ${verb} проверки`;
  }
  return 'База пустая. Начните с переписки WhatsApp';
}
