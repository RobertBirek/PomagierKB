/**
 * Polityka danych osobowych bazy wiedzy (`kb_registry.pii_policy`) — jedyne pole rejestru
 * KB edytowalne z panelu.
 *
 * Dlaczego akurat to, skoro reszta rejestru (routing, typy dokumentów) ustawiana jest przez
 * API: ta kontrolka decyduje, czy treść dokumentów opuszcza EOG w postaci jawnej. To decyzja
 * osoby odpowiedzialnej za bazę, a nie za deployment, i nie powinna wymagać `curl`a.
 *
 * Kontrakt: PATCH /api/v1/kbs/:namespace {piiPolicy} (admin, CSRF).
 * Uzasadnienie polityk i granicy maskowania: packages/shared/src/pii/policy.ts.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { t, type PlKey } from '@/i18n/t';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Select } from '@/ui/select';
import { useToast } from '@/ui/toast';

export const PII_POLICIES = ['off', 'flag', 'mask'] as const;
export type PiiPolicy = (typeof PII_POLICIES)[number];

const LABEL: Record<PiiPolicy, PlKey> = {
  off: 'kb.pii.off',
  flag: 'kb.pii.flag',
  mask: 'kb.pii.mask',
};

const DESCRIPTION: Record<PiiPolicy, PlKey> = {
  off: 'kb.pii.offDesc',
  flag: 'kb.pii.flagDesc',
  mask: 'kb.pii.maskDesc',
};

/** `off` jest jedynym wariantem, który WYŁĄCZA kontrolę — i tak ma wyglądać. */
const BADGE: Record<PiiPolicy, 'ok' | 'warn' | 'fail'> = { off: 'fail', flag: 'warn', mask: 'ok' };
const ICON = { off: ShieldOff, flag: ShieldAlert, mask: ShieldCheck } as const;

export interface PiiPolicyControlProps {
  namespace: string;
  policy: PiiPolicy;
  /** Bez uprawnień admina kontrolka jest tylko informacją — backend i tak odrzuci zapis. */
  canEdit: boolean;
}

export function PiiPolicyControl({ namespace, policy, canEdit }: PiiPolicyControlProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<PiiPolicy>(policy);

  const save = useMutation({
    mutationFn: (value: PiiPolicy) =>
      apiFetch(`/api/v1/kbs/${encodeURIComponent(namespace)}`, {
        method: 'PATCH',
        body: { piiPolicy: value },
      }),
    onSuccess: (_data, value) => {
      // Lista /kb i szczegóły dzielą prefiks ['kbs', …] — jedno unieważnienie odświeża oba,
      // więc plakietka w Sheecie nie zostaje na starej wartości po zapisie.
      void queryClient.invalidateQueries({ queryKey: ['kbs'] });
      toast.show(t('kb.pii.saved', { policy: t(LABEL[value]) }), 'ok');
    },
    onError: (err) => toast.show(errorMessage(err), 'fail'),
  });

  const Icon = ICON[policy];
  const dirty = draft !== policy;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text">
        <Icon size={15} aria-hidden="true" />
        {t('kb.pii.title')}
      </h3>
      <p className="text-sm text-text-secondary">{t('kb.pii.intro')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={BADGE[policy]}>{t(LABEL[policy])}</Badge>
        <span className="text-sm text-text-secondary">{t(DESCRIPTION[policy])}</span>
      </div>

      {canEdit && (
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('kb.pii.title')}
              value={draft}
              className="max-w-xs"
              onChange={(ev) => setDraft(ev.target.value as PiiPolicy)}
            >
              {PII_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t(LABEL[p])}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {t('common.save')}
            </Button>
          </div>

          {/* Ostrzeżenie POKAZUJEMY PRZED zapisem, nie po: wyłączenie wykrywania jest
              decyzją, a nie ustawieniem, i człowiek ma zobaczyć konsekwencję zanim kliknie. */}
          {draft === 'off' && (
            <Alert variant="fail" title={t('kb.pii.offWarnTitle')}>
              {t('kb.pii.offWarnBody')}
            </Alert>
          )}
          {draft === 'mask' && policy !== 'mask' && (
            <Alert variant="info" title={t('kb.pii.maskNoteTitle')}>
              {t('kb.pii.maskNoteBody')}
            </Alert>
          )}
          <p className="text-xs text-text-tertiary">{t('kb.pii.appliesNext')}</p>
        </div>
      )}
    </section>
  );
}
