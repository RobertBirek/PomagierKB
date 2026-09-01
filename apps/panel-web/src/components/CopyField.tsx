import { useState } from 'react';
import { t } from '../i18n/t';

export interface CopyFieldProps {
  value: string;
  /** Etykieta dostępności (np. „Klucz API"). */
  label?: string;
}

/** Pole tylko-do-odczytu z przyciskiem kopiowania (klucze, snippety, id). */
export function CopyField({ value, label }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* brak uprawnień clipboard — użytkownik zaznaczy ręcznie */
    }
  }

  return (
    <div className="copy-field">
      <code {...(label !== undefined ? { 'aria-label': label } : {})}>{value}</code>
      <button type="button" className="btn btn-sm" onClick={() => void copy()}>
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  );
}
