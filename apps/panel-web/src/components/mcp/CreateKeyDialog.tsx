/**
 * Dialog „Nowy klucz API": walidacja PRZY POLACH (mcp-page-lib —
 * validateCreateKeyForm; koniec zbiorczego komunikatu), tożsamość jak dotąd
 * (ja / istniejące konto serwisowe / nowe konto — admin), scope write z opisem
 * konsekwencji, TTL 1–365. Raw klucz wraca do rodzica (RawKeyDialog — raz).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/i18n/t';
import type { PlKey } from '@/i18n/pl';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Select } from '@/ui/select';
import { useToast } from '@/ui/toast';
import {
  validateCreateKeyForm,
  type CreateKeyErrorField,
  type KeyIdentity,
} from './mcp-page-lib';
import type { ApiKeyView, McpProfileView, UserView } from './types';

const ERROR_KEY: Record<CreateKeyErrorField, PlKey> = {
  label: 'mcp.create.err.label',
  profile: 'mcp.create.err.profile',
  service: 'mcp.create.err.service',
  serviceName: 'mcp.create.err.serviceName',
  ttl: 'mcp.create.err.ttl',
};

interface CreateKeyBody {
  label: string;
  profileId: string;
  scopes: string[];
  ttlDays: number;
  userId?: string;
}

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

export function CreateKeyDialog({
  open,
  onClose,
  isAdmin,
  profiles,
  serviceUsers,
  onRaw,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  profiles: McpProfileView[];
  serviceUsers: UserView[];
  onRaw: (raw: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [profileId, setProfileId] = useState('');
  const [identity, setIdentity] = useState<KeyIdentity>('me');
  const [serviceId, setServiceId] = useState('');
  const [newServiceName, setNewServiceName] = useState('');
  const [write, setWrite] = useState(false);
  const [ttlDays, setTtlDays] = useState(90);
  const [errors, setErrors] = useState<CreateKeyErrorField[]>([]);

  useEffect(() => {
    if (open) {
      setLabel('');
      setProfileId('');
      setIdentity('me');
      setServiceId('');
      setNewServiceName('');
      setWrite(false);
      setTtlDays(90);
      setErrors([]);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: async () => {
      let userId: string | undefined;
      if (identity === 'service') userId = serviceId;
      if (identity === 'new') {
        const created = await apiFetch<{ user: UserView }>('/api/v1/users', {
          method: 'POST',
          body: { kind: 'service', displayName: newServiceName.trim() },
        });
        userId = created.user.id;
      }
      const body: CreateKeyBody = {
        label: label.trim(),
        profileId,
        scopes: write ? ['read', 'write'] : ['read'],
        ttlDays,
      };
      if (userId !== undefined) body.userId = userId;
      return apiFetch<{ key: ApiKeyView; raw: string }>('/api/v1/mcp/keys', { method: 'POST', body });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'keys'] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.show(t('mcp.toast.keyCreated'), 'ok');
      onClose();
      onRaw(data.raw);
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  function fieldError(field: CreateKeyErrorField): string | undefined {
    return errors.includes(field) ? t(ERROR_KEY[field]) : undefined;
  }

  function submit(): void {
    const result = validateCreateKeyForm({ label, profileId, identity, serviceId, newServiceName, ttlDays });
    setErrors(result.errors);
    if (result.ok) create.mutate();
  }

  const activeServiceUsers = serviceUsers.filter((u) => u.status === 'active');
  const labelErr = fieldError('label');
  const profileErr = fieldError('profile');
  const serviceErr = fieldError('service');
  const serviceNameErr = fieldError('serviceName');
  const ttlErr = fieldError('ttl');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('mcp.create.title')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field
            label={t('mcp.keys.label')}
            required
            {...(labelErr !== undefined ? { error: labelErr } : {})}
          >
            <Input
              value={label}
              maxLength={200}
              placeholder={t('mcp.create.labelPlaceholder')}
              onChange={(ev) => setLabel(ev.target.value)}
            />
          </Field>

          <Field
            label={t('mcp.keys.profile')}
            required
            {...(profileErr !== undefined ? { error: profileErr } : {})}
          >
            <Select value={profileId} onChange={(ev) => setProfileId(ev.target.value)}>
              <option value="">—</option>
              {profiles
                .filter((p) => p.enabled)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
            </Select>
          </Field>

          {isAdmin && (
            <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium text-text">{t('mcp.create.identity')}</legend>
              <RadioGroup value={identity} onValueChange={(value) => setIdentity(value as KeyIdentity)}>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem value="me" />
                  {t('mcp.create.identityMe')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem value="service" disabled={activeServiceUsers.length === 0} />
                  {t('mcp.create.identityService')}
                </label>
                {identity === 'service' && (
                  <div className="pl-6">
                    <Field
                      label={t('mcp.create.identityService')}
                      {...(serviceErr !== undefined ? { error: serviceErr } : {})}
                    >
                      <Select value={serviceId} onChange={(ev) => setServiceId(ev.target.value)}>
                        <option value="">—</option>
                        {activeServiceUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.displayName}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <RadioGroupItem value="new" />
                  {t('mcp.create.identityNew')}
                </label>
                {identity === 'new' && (
                  <div className="pl-6">
                    <Field
                      label={t('mcp.create.serviceName')}
                      required
                      {...(serviceNameErr !== undefined ? { error: serviceNameErr } : {})}
                    >
                      <Input
                        value={newServiceName}
                        maxLength={120}
                        placeholder={t('mcp.create.serviceNamePlaceholder')}
                        onChange={(ev) => setNewServiceName(ev.target.value)}
                      />
                    </Field>
                  </div>
                )}
              </RadioGroup>
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">{t('mcp.create.scope')}</legend>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <Checkbox checked disabled />
              {t('mcp.create.scopeRead')}
            </label>
            {isAdmin && (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={write} onCheckedChange={(checked) => setWrite(checked === true)} />
                {t('mcp.create.scopeWrite')}
              </label>
            )}
          </fieldset>

          <Field
            label={t('mcp.create.ttl')}
            required
            {...(ttlErr !== undefined ? { error: ttlErr } : {})}
          >
            <Input
              type="number"
              min={1}
              max={365}
              className="max-w-32"
              value={ttlDays}
              onChange={(ev) => setTtlDays(Number(ev.target.value))}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            {t('mcp.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
