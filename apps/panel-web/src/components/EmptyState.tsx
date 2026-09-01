import type { ReactNode } from 'react';
import { t } from '../i18n/t';

export interface EmptyStateProps {
  /** Emoji/znak — celowo proste (bez biblioteki ikon). */
  icon?: string;
  title?: string;
  description?: string;
  /** CTA — soczewka product: „puste stany z konkretnym CTA". */
  action?: ReactNode;
}

export function EmptyState({ icon = '📭', title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title ?? t('emptyState.defaultTitle')}</h3>
      {description !== undefined && <p>{description}</p>}
      {action !== undefined && <div className="row" style={{ justifyContent: 'center' }}>{action}</div>}
    </div>
  );
}
