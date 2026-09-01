import { useState } from 'react';
import { useStatus } from '../hooks/useStatus';
import { buildHealthCockpit, type HealthStatus } from '../lib/health';
import { healthVariant } from '../lib/status';
import { t, type PlKey } from '../i18n/t';
import { pl } from '../i18n/pl';
import { Drawer } from './Drawer';
import { StatusBadge } from './StatusBadge';

/** Etykieta sygnału: klucz pl.ts (sygnały domenowe) LUB gotowy string z API. */
function signalLabel(label: string): string {
  return label in pl ? t(label as PlKey) : label;
}

const HEALTH_LABEL: Record<HealthStatus, PlKey> = {
  OK: 'header.health.ok',
  WARN: 'header.health.warn',
  FAIL: 'header.health.fail',
  UNKNOWN: 'header.health.unknown',
};

/**
 * Kompaktowy wskaźnik zdrowia w nagłówku (kropka + etykieta), zasilany
 * GET /api/v1/status co 15 s; klik → drawer ze szczegółami sygnałów.
 */
export function HealthIndicator() {
  const status = useStatus();
  const [open, setOpen] = useState(false);

  const cockpit = buildHealthCockpit({
    components: status.data?.components ?? [],
    breakers: status.data?.breakers ?? [],
  });
  const overall: HealthStatus = status.isError ? 'FAIL' : status.isPending ? 'UNKNOWN' : cockpit.overallStatus;
  const variant = healthVariant(overall);

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm health-indicator"
        title={t('header.health.title')}
        onClick={() => setOpen(true)}
      >
        <span className={`badge badge-${variant}`}>
          <span className="badge-dot" aria-hidden="true" />
          <span className="health-indicator-label">{t(HEALTH_LABEL[overall])}</span>
        </span>
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('header.health.title')}>
        {status.isPending && <p className="muted">{t('common.loading')}</p>}
        {status.isError && <p className="muted">{t('error.network')}</p>}
        {cockpit.signals.map((signal) => (
          <div key={signal.id} className="row card">
            <span className="grow">
              <strong>{signalLabel(signal.label)}</strong>
              {signal.value !== '' && <div className="muted">{signal.value}</div>}
            </span>
            <StatusBadge status={signal.status} />
          </div>
        ))}
      </Drawer>
    </>
  );
}
