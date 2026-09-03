import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn';

export interface FieldProps {
  label: ReactNode;
  /** Podpowiedź pod polem (ukrywana, gdy jest błąd). */
  hint?: ReactNode;
  /** Komunikat błędu — ustawia też aria-invalid na dziecku. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** Pojedyncza kontrolka (Input/Textarea/Select…) — dostaje id + aria-*. */
  children: ReactElement;
}

/**
 * Pole formularza: label + kontrolka + hint/błąd. Klonuje dziecko dodając
 * id (htmlFor), aria-describedby i aria-invalid — dostępność bez boilerplate'u.
 */
export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const id = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== '';
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = hasError ? errorId : hasHint ? hintId : undefined;

  const control = cloneElement(children as ReactElement<Record<string, unknown>>, {
    id,
    ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
    ...(hasError ? { 'aria-invalid': true } : {}),
  });

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
        {required ? (
          <span className="text-fail" aria-hidden="true">
            {' *'}
          </span>
        ) : null}
      </label>
      {control}
      {hasError ? (
        <p id={errorId} role="alert" className="text-xs text-fail">
          {error}
        </p>
      ) : hasHint ? (
        <p id={hintId} className="text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface FieldRowProps {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Kontrolka po prawej (Switch/Checkbox/Select…) — dostaje id. */
  children: ReactElement;
}

/** Wiersz ustawień: label (+hint) po lewej, kontrolka po prawej — do gęstych list. */
export function FieldRow({ label, hint, className, children }: FieldRowProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hasHint = hint !== undefined && hint !== null && hint !== '';

  const control = cloneElement(children as ReactElement<Record<string, unknown>>, {
    id,
    ...(hasHint ? { 'aria-describedby': hintId } : {}),
  });

  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col">
        <label htmlFor={id} className="text-sm text-text">
          {label}
        </label>
        {hasHint ? (
          <span id={hintId} className="text-xs text-text-secondary">
            {hint}
          </span>
        ) : null}
      </div>
      {control}
    </div>
  );
}
