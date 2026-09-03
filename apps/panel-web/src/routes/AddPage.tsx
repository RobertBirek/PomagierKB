/**
 * /add „Dodaj treść" na kicie v2 — dwie kolumny (formularz | aside z postępem
 * lub „Ostatnio dodane"), Tabs URL-sync ?tab=text|file:
 * - TEKST: Field(Textarea) z licznikiem znaków (limit 100 000 = DRAFT_LIMITS.contentMax
 *   backendu), Tytuł/URL-metadana; bez selecta KB (bazę dobiera analiza — Alert info);
 * - PLIK: dropzone multi-plik z kolejką kliencką (fileQueue reducer) i wysyłką
 *   sekwencyjną 1 POST/plik z paskiem postępu (uploadWithProgress XHR — apiFetch
 *   nietykalny); select KB zostaje z hintem; walidacja przy polach, nie toastem.
 * Prefill ?question= z luki wiedzy (baner). Kontrakt API: routes/content.ts.
 */
import { useCallback, useReducer, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Paperclip, Puzzle, X } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { UPLOAD_ACCEPT, UPLOAD_EXTENSIONS, validateUploadFile } from '@/lib/intake';
import { can } from '@/lib/permissions';
import { useMe } from '@/hooks/useMe';
import { t, formatNumber } from '@/i18n/t';
import type { AddSearch } from '@/router';
import { cn } from '@/ui/cn';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button, IconButton } from '@/ui/button';
import { Card, CardBody } from '@/ui/card';
import { Field } from '@/ui/field';
import { Input } from '@/ui/input';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { Select } from '@/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Textarea } from '@/ui/textarea';
import { IntakeProgress } from '@/components/add/IntakeProgress';
import { RecentIntakes, type RetryRequest } from '@/components/add/RecentIntakes';
import {
  fileQueueReducer,
  hasQueued,
  type FileQueueItem,
} from '@/components/add/fileQueue';
import { uploadWithProgress } from '@/components/add/uploadWithProgress';
import { formatSize, type KbItem, type SubmitResponse } from '@/components/add/types';

const EXT_LIST = UPLOAD_EXTENSIONS.join(', ');

/** Limit długości treści tekstowej = DRAFT_LIMITS.contentMax backendu
 *  (packages/shared/src/db/repos/drafts.ts; routes/content.ts zwraca
 *  payload_too_large powyżej). */
const TEXT_MAX = 100_000;
/** Próg ostrzeżenia licznika znaków (90% limitu). */
const TEXT_WARN = TEXT_MAX * 0.9;

type AddTab = 'text' | 'file';

export function AddPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ from: '/add' });
  const gapQuestion = search.question;
  const tab: AddTab = search.tab === 'file' ? 'file' : 'text';

  // ── stan formularza tekstowego ──
  const [text, setText] = useState('');
  const [title, setTitle] = useState(gapQuestion ?? '');
  const [sourceUrl, setSourceUrl] = useState('');
  const [textError, setTextError] = useState<string | null>(null);

  // ── stan trybu plikowego (kolejka kliencka + obiekty File poza reducerem) ──
  const [queue, dispatchQueue] = useReducer(fileQueueReducer, [] as readonly FileQueueItem[]);
  const filesRef = useRef(new Map<string, File>());
  const [namespace, setNamespace] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [retryInfo, setRetryInfo] = useState<'text' | 'file' | null>(null);
  const [active, setActive] = useState<{ intakeId: string; deduplicated: boolean } | null>(null);

  const kbsQuery = useQuery({
    queryKey: ['kbs'],
    queryFn: () => apiFetch<{ items: KbItem[] }>('/api/v1/kbs'),
    staleTime: 60_000,
  });
  const activeKbs = (kbsQuery.data?.items ?? []).filter((kb) => kb.status === 'active');
  const defaultKb = activeKbs.find((kb) => kb.isDefault);

  /** Zmiana zakładki — URL-sync ?tab= (replace, bez wpisu w historii). */
  const goTab = (value: string): void => {
    const next: AddSearch = {};
    if (gapQuestion !== undefined) next.question = gapQuestion;
    if (value === 'file') next.tab = 'file';
    void navigate({ to: '/add', search: next, replace: true });
  };

  // ── tryb TEKST: POST JSON {text,title?,sourceUrl?} (KB dobiera analiza) ──
  const submitText = useMutation({
    mutationFn: (input: { text: string; title: string; sourceUrl: string }) => {
      const body: { text: string; title?: string; sourceUrl?: string } = { text: input.text };
      if (input.title !== '') body.title = input.title;
      if (input.sourceUrl !== '') body.sourceUrl = input.sourceUrl;
      return apiFetch<SubmitResponse>('/api/v1/content', { method: 'POST', body });
    },
    onSuccess: (data) => {
      setActive({ intakeId: data.intakeId, deduplicated: data.deduplicated === true });
      setText('');
      setTitle('');
      setSourceUrl('');
      setTextError(null);
      setRetryInfo(null);
      void queryClient.invalidateQueries({ queryKey: ['content-list'] });
    },
    onError: (err) => {
      setTextError(err instanceof ApiError ? err.message : t('common.error'));
    },
  });

  function handleTextSubmit(): void {
    if (submitText.isPending) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      setTextError(t('add.text.required'));
      return;
    }
    if (text.length > TEXT_MAX) {
      setTextError(t('add.text.tooLong', { max: formatNumber(TEXT_MAX) }));
      return;
    }
    setTextError(null);
    submitText.mutate({ text: trimmed, title: title.trim(), sourceUrl: sourceUrl.trim() });
  }

  // ── tryb PLIK: kolejka + wysyłka sekwencyjna z postępem ──
  function addFiles(candidates: Iterable<File>): void {
    const rejected: { name: string; code: 'extension' | 'size' }[] = [];
    const items: { id: string; name: string; size: number }[] = [];
    for (const file of candidates) {
      const verdict = validateUploadFile(file.name, file.size);
      if (!verdict.ok) {
        rejected.push({ name: file.name, code: verdict.code });
        continue;
      }
      const id = crypto.randomUUID();
      filesRef.current.set(id, file);
      items.push({ id, name: file.name, size: file.size });
    }
    if (items.length > 0) dispatchQueue({ type: 'add', items });
    // Jeden odrzucony plik → precyzyjny komunikat; więcej → lista nazw.
    if (rejected.length === 0) setFileError(null);
    else if (rejected.length === 1 && rejected[0] !== undefined) {
      setFileError(
        rejected[0].code === 'size'
          ? t('add.file.tooLarge')
          : t('add.file.badExtension', { list: EXT_LIST }),
      );
    } else {
      setFileError(t('add.queue.invalid', { list: rejected.map((r) => r.name).join(', ') }));
    }
  }

  function onDrop(ev: DragEvent<HTMLDivElement>): void {
    ev.preventDefault();
    setDragOver(false);
    addFiles(ev.dataTransfer.files);
  }

  async function uploadAll(): Promise<void> {
    if (uploading) return;
    if (!hasQueued(queue)) {
      setFileError(t('add.file.required'));
      return;
    }
    setUploading(true);
    setFileError(null);
    setRetryInfo(null);
    const toSend = queue.filter((item) => item.status === 'queued');
    for (const item of toSend) {
      const file = filesRef.current.get(item.id);
      if (file === undefined) {
        dispatchQueue({ type: 'fail', id: item.id, error: t('common.error') });
        continue;
      }
      dispatchQueue({ type: 'start', id: item.id });
      try {
        const form = new FormData();
        form.append('file', file);
        // KB jako pole multipart — dziś ignorowane przez backend (analyze
        // routuje sam), forward-compatible gdy content.ts zacznie je czytać.
        const chosen = namespace !== '' ? namespace : defaultKb?.namespace;
        if (chosen !== undefined) form.append('namespace', chosen);
        const res = await uploadWithProgress<SubmitResponse>('/api/v1/content', form, (fraction) =>
          dispatchQueue({ type: 'progress', id: item.id, progress: fraction }),
        );
        dispatchQueue({
          type: 'done',
          id: item.id,
          intakeId: res.intakeId,
          deduplicated: res.deduplicated === true,
        });
        filesRef.current.delete(item.id);
        setActive({ intakeId: res.intakeId, deduplicated: res.deduplicated === true });
        void queryClient.invalidateQueries({ queryKey: ['content-list'] });
      } catch (err) {
        dispatchQueue({
          type: 'fail',
          id: item.id,
          error: err instanceof ApiError ? err.message : t('common.error'),
        });
      }
    }
    setUploading(false);
  }

  function onSubmit(ev: FormEvent): void {
    ev.preventDefault();
    if (tab === 'text') handleTextSubmit();
    else void uploadAll();
  }

  const collapseActive = useCallback(() => setActive(null), []);
  const addAnother = useCallback(() => {
    setActive(null);
    setRetryInfo(null);
  }, []);

  /** „Ponów" z Ostatnio dodanych: prefill formularza (treści/pliku nie przechowujemy). */
  function handleRetry(req: RetryRequest): void {
    setActive(null);
    if (req.sourceKind === 'text') {
      setRetryInfo('text');
      setTitle(req.originalName ?? '');
      goTab('text');
    } else {
      setRetryInfo('file');
      goTab('file');
    }
  }

  const canInbox = can(me.data?.user.role, 'inbox');
  const charPct = text.length;
  const counterClass =
    charPct > TEXT_MAX ? 'text-fail' : charPct >= TEXT_WARN ? 'text-warn' : 'text-text-tertiary';

  return (
    <PageContainer width="form">
      <PageHeader title={t('add.pageTitle')} description={t('add.pageDescription')} />

      {gapQuestion !== undefined && (
        <Alert
          variant="info"
          icon={<Puzzle size={16} className="text-accent" />}
          className="mb-5 border-accent/25 bg-accent-tint"
        >
          {t('add.gapHeader', { question: gapQuestion })}
        </Alert>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardBody>
            <form className="flex flex-col gap-4" onSubmit={onSubmit}>
              {retryInfo !== null && (
                <Alert variant="info">
                  {retryInfo === 'text' ? t('add.retry.textInfo') : t('add.retry.fileInfo')}
                </Alert>
              )}

              <Tabs value={tab} onValueChange={goTab}>
                <TabsList>
                  <TabsTrigger value="text">{t('add.tab.text')}</TabsTrigger>
                  <TabsTrigger value="file">{t('add.tab.file')}</TabsTrigger>
                </TabsList>

                <TabsContent value="text" className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <Field
                      label={t('add.text.label')}
                      required
                      {...(textError !== null ? { error: textError } : {})}
                    >
                      <Textarea
                        rows={10}
                        value={text}
                        placeholder={t('add.text.placeholder')}
                        onChange={(ev) => {
                          setText(ev.target.value);
                          if (textError !== null) setTextError(null);
                        }}
                      />
                    </Field>
                    {/* licznik znaków: n/max, warn przy 90% limitu backendu */}
                    <div
                      className={cn('self-end text-xs tabular-nums', counterClass)}
                      {...(charPct >= TEXT_WARN && charPct <= TEXT_MAX
                        ? { title: t('add.charCountWarn') }
                        : {})}
                    >
                      {t('add.charCount', { n: formatNumber(text.length), max: formatNumber(TEXT_MAX) })}
                    </div>
                  </div>
                  <Field label={t('add.titleField.label')}>
                    <Input value={title} onChange={(ev) => setTitle(ev.target.value)} />
                  </Field>
                  <Field label={t('add.sourceUrl.label')} hint={t('add.sourceUrl.hint')}>
                    <Input
                      type="url"
                      value={sourceUrl}
                      placeholder="https://…"
                      onChange={(ev) => setSourceUrl(ev.target.value)}
                    />
                  </Field>
                  {/* bez selecta KB — bazę dobiera analiza treści (plan: atrapa usunięta) */}
                  <Alert variant="info">{t('add.kbAuto.info')}</Alert>
                </TabsContent>

                <TabsContent value="file" className="flex flex-col gap-4">
                  <div
                    className={cn(
                      'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
                      dragOver ? 'border-accent bg-accent-tint' : 'border-border',
                    )}
                    onDragOver={(ev) => {
                      ev.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                  >
                    <Paperclip size={20} className="text-text-tertiary" aria-hidden="true" />
                    <span className="text-sm text-text">{t('add.file.dropHere')}</span>
                    <Button onClick={() => fileInputRef.current?.click()}>
                      {t('add.file.pick')}
                    </Button>
                    <span className="text-xs text-text-secondary">
                      {t('add.file.accepted', { list: EXT_LIST })}
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={UPLOAD_ACCEPT}
                      multiple
                      className="hidden"
                      onChange={(ev) => {
                        if (ev.target.files !== null) addFiles(ev.target.files);
                        ev.target.value = '';
                      }}
                    />
                  </div>
                  {fileError !== null && (
                    <p role="alert" className="text-xs text-fail">
                      {fileError}
                    </p>
                  )}

                  {queue.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-text-secondary">
                        {t('add.queue.title', { count: queue.length })}
                      </span>
                      <ul className="flex flex-col gap-1">
                        {queue.map((item) => (
                          <li
                            key={item.id}
                            className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 grow truncate text-sm text-text">
                                {item.name}
                              </span>
                              <Badge variant="neutral" tone="outline">
                                {formatSize(item.size)}
                              </Badge>
                              {item.status === 'queued' && (
                                <Badge variant="neutral">{t('add.queue.status.queued')}</Badge>
                              )}
                              {item.status === 'uploading' && (
                                <span className="flex items-center gap-2">
                                  <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3">
                                    {/* szerokość dynamiczna — dozwolony inline style */}
                                    <span
                                      className="block h-full rounded-full bg-accent transition-[width]"
                                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                                    />
                                  </span>
                                  <span className="text-xs tabular-nums text-text-secondary">
                                    {t('add.queue.status.uploading', {
                                      pct: Math.round(item.progress * 100),
                                    })}
                                  </span>
                                </span>
                              )}
                              {item.status === 'done' && (
                                <Badge variant="ok">{t('add.queue.status.done')}</Badge>
                              )}
                              {item.status === 'failed' && (
                                <Badge variant="fail">{t('add.queue.status.failed')}</Badge>
                              )}
                              <IconButton
                                aria-label={t('add.queue.remove', { name: item.name })}
                                size="icon-sm"
                                disabled={item.status === 'uploading'}
                                onClick={() => {
                                  filesRef.current.delete(item.id);
                                  dispatchQueue({ type: 'remove', id: item.id });
                                }}
                              >
                                <X size={14} aria-hidden="true" />
                              </IconButton>
                            </div>
                            {item.status === 'failed' && item.error !== undefined && (
                              <p className="text-xs text-fail">{item.error}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* w trybie plikowym wybór KB ZOSTAJE (hint o analizie) */}
                  <Field label={t('add.kb.label')} hint={t('add.kb.hint')}>
                    <Select value={namespace} onChange={(ev) => setNamespace(ev.target.value)}>
                      <option value="">{t('add.kb.auto')}</option>
                      {activeKbs.map((kb) => (
                        <option key={kb.namespace} value={kb.namespace}>
                          {kb.name} ({kb.namespace}){kb.isDefault ? ' ★' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </TabsContent>
              </Tabs>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  loading={submitText.isPending || uploading}
                >
                  {submitText.isPending || uploading ? t('add.submitting') : t('add.submit')}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        {/* aside: aktywny postęp LUB ostatnio dodane */}
        <aside className="flex flex-col gap-4">
          {active !== null ? (
            <IntakeProgress
              intakeId={active.intakeId}
              deduplicated={active.deduplicated}
              canInbox={canInbox}
              onAddAnother={addAnother}
              onCollapsed={collapseActive}
            />
          ) : (
            <RecentIntakes onRetry={handleRetry} />
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
