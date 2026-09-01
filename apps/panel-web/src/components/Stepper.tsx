export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

export interface Step {
  id: string;
  label: string;
  /** Ludzki opis etapu (soczewka product: etapy dokumentu, nie joba). */
  description?: string;
  status: StepStatus;
}

/** Pionowy stepper etapów (intake pipeline na /add, provisioning na /kb). */
export function Stepper({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className="stepper">
      {steps.map((step, i) => (
        <li key={step.id} data-status={step.status}>
          <span className="stepper-marker">
            <span className="stepper-dot" aria-hidden="true">
              {step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : i + 1}
            </span>
            {i < steps.length - 1 && <span className="stepper-line" aria-hidden="true" />}
          </span>
          <span className="stepper-body">
            <span className="stepper-label">{step.label}</span>
            {step.description !== undefined && <div className="muted">{step.description}</div>}
          </span>
        </li>
      ))}
    </ol>
  );
}
