/**
 * Dialog formularza profilu MCP (tworzenie/edycja) — walidacja z NIETYKALNEGO
 * lib/mcp (validateProfileForm), błędy mapowane NA KONKRETNE POLA.
 * Lista KB: przewijalna (max-h-56) z SearchInputem i „zaznacz widoczne".
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { MCP_TOOLS, validateProfileForm, type ProfileFormErrorField } from '@/lib/mcp';
import { t } from '@/i18n/t';
import type { PlKey } from '@/i18n/pl';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { SearchInput } from '@/ui/search-input';
import { Textarea } from '@/ui/textarea';
import { useToast } from '@/ui/toast';
import type { McpProfileView } from './types';

const PROFILE_ERROR_KEY: Record<ProfileFormErrorField, PlKey> = {
  id: 'mcp.profiles.err.id',
  name: 'mcp.profiles.err.name',
  tools: 'mcp.profiles.err.tools',
  namespaces: 'mcp.profiles.err.namespaces',
};

function errMsg(err: unknown): string {
  return err instanceof ApiError ? err.message : t('common.error');
}

export function ProfileFormDialog({
  open,
  onClose,
  editing,
  namespaces,
}: {
  open: boolean;
  onClose: () => void;
  /** null = tworzenie nowego profilu. */
  editing: McpProfileView | null;
  namespaces: string[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [tools, setTools] = useState<string[]>(editing?.tools ?? ['kb_search', 'kb_answer', 'kb_list']);
  const [allNamespaces, setAllNamespaces] = useState(editing === null || editing.namespaces === null);
  const [picked, setPicked] = useState<string[]>(editing?.namespaces ?? []);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [errors, setErrors] = useState<ProfileFormErrorField[]>([]);
  const [nsQuery, setNsQuery] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        namespaces: allNamespaces ? null : picked,
        tools,
        enabled,
      };
      return editing === null
        ? apiFetch<McpProfileView>('/api/v1/mcp/profiles', { method: 'POST', body: { id, ...body } })
        : apiFetch<McpProfileView>(`/api/v1/mcp/profiles/${editing.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mcp', 'profiles'] });
      toast.show(t('mcp.toast.profileSaved'), 'ok');
      onClose();
    },
    onError: (err) => toast.show(errMsg(err), 'fail'),
  });

  function toggle(list: string[], item: string): string[] {
    return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  }

  function submit(): void {
    const result = validateProfileForm({ id, name, tools, allNamespaces, namespaces: picked }, namespaces);
    setErrors(result.errors);
    if (result.ok) save.mutate();
  }

  const fieldError = (field: ProfileFormErrorField): string | undefined =>
    errors.includes(field) ? t(PROFILE_ERROR_KEY[field]) : undefined;

  const idErr = fieldError('id');
  const nameErr = fieldError('name');
  const toolsErr = fieldError('tools');
  const nsErr = fieldError('namespaces');

  const q = nsQuery.trim().toLowerCase();
  const visibleNs = q === '' ? namespaces : namespaces.filter((ns) => ns.toLowerCase().includes(q));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{editing === null ? t('mcp.profiles.create') : t('mcp.profiles.editTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field
            label={t('mcp.profiles.id')}
            required
            hint={t('mcp.profiles.idHint')}
            {...(idErr !== undefined ? { error: idErr } : {})}
          >
            <Input
              value={id}
              disabled={editing !== null}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              onChange={(ev) => setId(ev.target.value)}
            />
          </Field>
          <Field
            label={t('mcp.profiles.name')}
            required
            {...(nameErr !== undefined ? { error: nameErr } : {})}
          >
            <Input value={name} maxLength={200} onChange={(ev) => setName(ev.target.value)} />
          </Field>
          <Field label={t('mcp.profiles.description')}>
            <Textarea
              rows={2}
              value={description}
              maxLength={2000}
              onChange={(ev) => setDescription(ev.target.value)}
            />
          </Field>

          <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">{t('mcp.profiles.tools')}</legend>
            {MCP_TOOLS.map((tool) => (
              <label key={tool} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={tools.includes(tool)}
                  onCheckedChange={() => setTools((prev) => toggle(prev, tool))}
                />
                <code className="font-mono text-xs">{tool}</code>
              </label>
            ))}
            {toolsErr !== undefined && (
              <p role="alert" className="text-xs text-fail">
                {toolsErr}
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium text-text">{t('mcp.profiles.namespaces')}</legend>
            <RadioGroup
              value={allNamespaces ? 'all' : 'pick'}
              onValueChange={(value) => setAllNamespaces(value === 'all')}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="all" />
                {t('mcp.profiles.namespacesAll')}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value="pick" />
                {t('mcp.profiles.namespacesPick')}
              </label>
            </RadioGroup>
            {!allNamespaces && (
              <div className="flex flex-col gap-2 pl-6">
                <div className="flex items-center gap-2">
                  <SearchInput
                    className="grow"
                    placeholder={t('mcp.profiles.nsSearchPlaceholder')}
                    onDebouncedChange={setNsQuery}
                  />
                  <Button
                    size="sm"
                    disabled={visibleNs.length === 0}
                    onClick={() =>
                      setPicked((prev) => [...new Set([...prev, ...visibleNs])])
                    }
                  >
                    {t('mcp.profiles.selectVisible')}
                  </Button>
                </div>
                <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                  {visibleNs.length === 0 ? (
                    <p className="text-xs text-text-tertiary">{t('mcp.profiles.noNsMatches')}</p>
                  ) : (
                    visibleNs.map((ns) => (
                      <label key={ns} className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={picked.includes(ns)}
                          onCheckedChange={() => setPicked((prev) => toggle(prev, ns))}
                        />
                        <code className="font-mono text-xs">{ns}</code>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
            {nsErr !== undefined && (
              <p role="alert" className="text-xs text-fail">
                {nsErr}
              </p>
            )}
          </fieldset>

          {editing !== null && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
              {t('mcp.profiles.enabledField')}
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
