/**
 * /ask „Zapytaj bazę" v2 (Faza 3, kit ui/): czat z bazą wiedzy przez SSE
 * (POST /api/v1/ask — eventy status/result/error; logika strumienia bez zmian).
 * Nowości prezentacji: wątek trwały w sessionStorage (lib/askThread), composer
 * sticky z przyciskiem „Zatrzymaj" (abort → stan „przerwano"), historia w aside
 * ≥1280px / Sheet poniżej, „Nowy wątek" z toast+Cofnij, kopiowanie odpowiedzi,
 * feedback na ikonach lucide z Popoverem komentarza.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { History, MessageSquare, Plus, Send, Square } from 'lucide-react';
import { apiSse, ApiError } from '../lib/api';
import { confidenceBadge } from '../lib/confidence';
import {
  ASK_THREAD_STORAGE_KEY,
  deserializeThread,
  nextThreadKey,
  serializeThread,
  type ThreadCitation,
  type ThreadEntry,
} from '../lib/askThread';
import type { AskHistoryItem } from '../lib/askHistory';
import { can } from '../lib/permissions';
import { useMe } from '../hooks/useMe';
import { AnswerCard } from '../components/ask/AnswerCard';
import { HistoryPanel } from '../components/ask/HistoryPanel';
import { SafeExternalLink } from '../components/SafeExternalLink';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { EmptyState } from '@/ui/empty-state';
import { Kbd } from '@/ui/kbd';
import { PageContainer } from '@/ui/page-container';
import { PageHeader } from '@/ui/page-header';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import { useToast } from '@/ui/toast';
import { t, formatDateTime, type PlKey } from '../i18n/t';

// ── Kontrakt /api/v1/ask (AnswerResult + AnswerPhase z shared/answer) ────────

type AskPhase = 'retrieval' | 'generating';

/** Wpis wątku + przejściowa faza SSE (nie jest utrwalana w sessionStorage). */
type ChatEntry = ThreadEntry & { phase: AskPhase | null };

function parseJsonSafe(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

function loadThread(): ChatEntry[] {
  try {
    return deserializeThread(sessionStorage.getItem(ASK_THREAD_STORAGE_KEY)).map((e) => ({
      ...e,
      phase: null,
    }));
  } catch {
    return [];
  }
}

function saveThread(entries: readonly ChatEntry[]): void {
  try {
    sessionStorage.setItem(ASK_THREAD_STORAGE_KEY, serializeThread(entries));
  } catch {
    /* prywatny tryb / brak storage — wątek działa bez trwałości */
  }
}

const EXAMPLE_KEYS: readonly PlKey[] = ['ask.example.1', 'ask.example.2', 'ask.example.3'];

// ── Strona ───────────────────────────────────────────────────────────────────

export function AskPage() {
  const me = useMe();
  const toast = useToast();
  const queryClient = useQueryClient();
  const role = me.data?.user.role;
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>(loadThread);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openCitation, setOpenCitation] = useState<ThreadCitation | null>(null);
  const [previewItem, setPreviewItem] = useState<AskHistoryItem | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const nextKey = useRef(nextThreadKey(entries));

  // Autofocus tylko na desktopie (mobile: nie wywołuj klawiatury od razu).
  useEffect(() => {
    if (window.matchMedia('(min-width: 769px)').matches) inputRef.current?.focus();
  }, []);

  // Przerwij strumień przy odmontowaniu strony.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Trwałość wątku: zapis przy każdej zmianie (defensywnie w try/catch).
  useEffect(() => {
    saveThread(entries);
  }, [entries]);

  // Autoscroll do końca przy nowym wpisie / zmianie fazy lub wyniku ostatniego
  // wpisu (patch werdyktu feedbacku NIE przewija).
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const scrollSig =
    last === undefined ? '' : `${last.key}:${last.phase ?? ''}:${last.result !== null}:${last.error ?? ''}`;
  useEffect(() => {
    if (scrollSig !== '') endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [scrollSig]);

  const patchEntry = useCallback((key: number, patch: Partial<ChatEntry>) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }, []);

  const submit = useCallback(
    async (rawQuestion: string): Promise<void> => {
      const q = rawQuestion.trim();
      if (q === '' || busy) return;
      const blank: Omit<ChatEntry, 'key' | 'question'> = {
        phase: null,
        result: null,
        error: null,
        stopped: false,
        verdict: null,
      };
      // Kontrakt POST /api/v1/ask: question minLength 5 — komunikat PL zamiast 400.
      if (q.length < 5) {
        setEntries((prev) => [
          ...prev,
          { ...blank, key: nextKey.current++, question: q, error: t('ask.tooShort') },
        ]);
        return;
      }
      const key = nextKey.current++;
      setEntries((prev) => [...prev, { ...blank, key, question: q }]);
      setQuestion('');
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      let gotResult = false;
      try {
        await apiSse('/api/v1/ask', { question: q }, {
          signal: controller.signal,
          onEvent: (ev) => {
            if (ev.event === 'status') {
              const data = parseJsonSafe(ev.data) as { phase?: string } | null;
              const phase = data?.phase;
              if (phase === 'retrieval' || phase === 'generating') patchEntry(key, { phase });
            } else if (ev.event === 'result') {
              const result = parseJsonSafe(ev.data) as ThreadEntry['result'] | null;
              if (result !== null && typeof result.answer === 'string') {
                gotResult = true;
                patchEntry(key, {
                  result: { ...result, citations: Array.isArray(result.citations) ? result.citations : [] },
                  phase: null,
                });
              }
            } else if (ev.event === 'error') {
              // Backend po hijacku SSE wysyła błąd jako event {code,label} (routes/ask.ts).
              const data = parseJsonSafe(ev.data) as { label?: string } | null;
              gotResult = true; // błąd już pokazany — nie nadpisuj go generycznym
              patchEntry(key, {
                phase: null,
                error: typeof data?.label === 'string' && data.label !== '' ? data.label : t('common.error'),
              });
            }
          },
        });
        if (!gotResult) patchEntry(key, { phase: null, error: t('common.error') });
        void queryClient.invalidateQueries({ queryKey: ['ask-history'] });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // „Zatrzymaj": osobny stan wpisu (i18n ask.stopped), NIE generyczny błąd.
          patchEntry(key, { phase: null, stopped: true });
          return;
        }
        const message = err instanceof ApiError ? err.message : t('common.error');
        patchEntry(key, { phase: null, error: message });
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, patchEntry, queryClient],
  );

  function onSubmit(ev: FormEvent): void {
    ev.preventDefault();
    void submit(question);
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>): void {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void submit(question);
    }
  }

  /** „Nowy wątek": czyści wątek; przy niepustym — toast z akcją Cofnij (snapshot). */
  function newThread(): void {
    if (entries.length === 0) return;
    const snapshot = entries;
    setEntries([]);
    toast.push({
      title: t('ask.newThread.cleared'),
      kind: 'info',
      action: { label: t('ask.newThread.undo'), onClick: () => setEntries(snapshot) },
    });
  }

  function askExample(key: PlKey): void {
    const q = t(key);
    setQuestion(q);
    void submit(q);
  }

  const canFeedback = can(role, 'feedback');
  const canPropose = can(role, 'propose');

  const composer = (
    <form
      onSubmit={onSubmit}
      className="sticky bottom-14 z-10 mt-auto border-t border-border bg-bg pb-1 pt-3 md:bottom-0"
    >
      <label className="sr-only" htmlFor="ask-input">
        {t('ask.inputLabel')}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id="ask-input"
          ref={inputRef}
          rows={1}
          value={question}
          placeholder={t('ask.inputPlaceholder')}
          onChange={(ev) => setQuestion(ev.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
          className="field-sizing-content max-h-44 min-h-9 grow resize-none"
        />
        {busy ? (
          <Button
            variant="secondary"
            iconLeft={<Square size={16} aria-hidden="true" />}
            onClick={() => abortRef.current?.abort()}
          >
            {t('ask.stop')}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            iconLeft={<Send size={16} aria-hidden="true" />}
            disabled={question.trim() === ''}
          >
            {t('ask.send')}
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-2xs text-text-tertiary">
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> {t('ask.hint.enter')}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> {t('ask.hint.newline')}
        </span>
      </div>
    </form>
  );

  return (
    <PageContainer width="prose" className="xl:max-w-[1080px]">
      <PageHeader
        title={t('ask.title')}
        description={t('ask.description')}
        actions={
          <>
            <Button
              variant="secondary"
              className="xl:hidden"
              iconLeft={<History size={16} aria-hidden="true" />}
              onClick={() => setHistoryOpen(true)}
            >
              {t('ask.historyButton')}
            </Button>
            <Button
              variant="secondary"
              iconLeft={<Plus size={16} aria-hidden="true" />}
              disabled={entries.length === 0}
              onClick={newThread}
            >
              {t('ask.newThread')}
            </Button>
          </>
        }
      />

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start xl:gap-6">
        {/* Kolumna wątku + sticky composer na dole obszaru */}
        <div className="flex min-h-[60dvh] flex-col">
          {entries.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title={t('ask.emptyTitle')}
              description={t('ask.emptyDescription')}
              action={
                <div className="flex max-w-md flex-wrap justify-center gap-2">
                  {EXAMPLE_KEYS.map((key) => (
                    <Button key={key} size="sm" variant="secondary" onClick={() => askExample(key)}>
                      {t(key)}
                    </Button>
                  ))}
                </div>
              }
            />
          ) : (
            <div className="flex flex-col gap-5 pb-4">
              {entries.map((entry) => (
                <div key={entry.key} className="flex flex-col gap-2">
                  <div className="max-w-[85%] self-end rounded-lg bg-accent-tint px-3 py-2 text-sm text-text">
                    {entry.question}
                  </div>
                  {entry.phase !== null && (
                    <div role="status" className="flex items-center gap-2 text-sm text-text-secondary">
                      <Spinner size={14} />
                      {t(entry.phase === 'retrieval' ? 'ask.phase.retrieval' : 'ask.phase.generating')}
                    </div>
                  )}
                  {entry.stopped && (
                    <Alert variant="info" icon={<Square size={16} aria-hidden="true" />}>
                      {t('ask.stopped')}
                    </Alert>
                  )}
                  {entry.error !== null && (
                    <Alert variant="fail">{t('ask.error', { message: entry.error })}</Alert>
                  )}
                  <AnswerCard
                    entry={entry}
                    canFeedback={canFeedback}
                    canPropose={canPropose}
                    onOpenCitation={setOpenCitation}
                    onVerdictSaved={(key, verdict) => patchEntry(key, { verdict })}
                  />
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
          {composer}
        </div>

        {/* Stały aside historii ≥1280px */}
        <aside className="hidden xl:block">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-text">{t('ask.history.title')}</h2>
            <HistoryPanel
              onPreview={(item) => {
                setPreviewItem(item);
              }}
            />
          </Card>
        </aside>
      </div>

      {/* Historia w Sheet (<1280px) */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" size="sm">
          <SheetHeader>
            <SheetTitle>{t('ask.history.title')}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            <HistoryPanel
              onPreview={(item) => {
                setHistoryOpen(false);
                setPreviewItem(item);
              }}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Cytowanie [n] — Sheet szczegółów źródła */}
      <Sheet open={openCitation !== null} onOpenChange={(open) => { if (!open) setOpenCitation(null); }}>
        <SheetContent side="right" size="md">
          {openCitation !== null && (
            <>
              <SheetHeader>
                <SheetTitle>{t('ask.citation.drawerTitle', { n: openCitation.n })}</SheetTitle>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-3 text-sm">
                <strong className="text-text">{openCitation.title ?? openCitation.id}</strong>
                <div>
                  <span className="text-text-tertiary">{t('ask.citation.namespace')}: </span>
                  {openCitation.namespace}
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-text-tertiary">{t('ask.citation.snippet')}</span>
                  {openCitation.snippet !== undefined && openCitation.snippet !== '' ? (
                    <blockquote className="rounded-md border-l-2 border-border-strong bg-surface-2 px-3 py-2 text-text-secondary">
                      {openCitation.snippet}
                    </blockquote>
                  ) : (
                    <p className="text-text-secondary">{t('ask.citation.noSnippet')}</p>
                  )}
                </div>
                {openCitation.sourceRef !== undefined && openCitation.sourceRef !== '' && (
                  <div className="flex flex-col gap-1">
                    <span className="text-text-tertiary">{t('ask.citation.sourceRef')}</span>
                    <SafeExternalLink href={openCitation.sourceRef}>{openCitation.sourceRef}</SafeExternalLink>
                  </div>
                )}
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Podgląd pozycji historii */}
      <Sheet open={previewItem !== null} onOpenChange={(open) => { if (!open) setPreviewItem(null); }}>
        <SheetContent side="right" size="md">
          {previewItem !== null && (
            <>
              <SheetHeader>
                <SheetTitle>{t('ask.history.preview')}</SheetTitle>
              </SheetHeader>
              <SheetBody className="flex flex-col gap-3">
                <p className="text-sm font-medium text-text">{previewItem.question}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {previewItem.noAnswer ? (
                    <Badge variant="warn">{t('ask.history.noAnswerBadge')}</Badge>
                  ) : (
                    <Badge variant={confidenceBadge(previewItem.confidence).variant}>
                      {t(confidenceBadge(previewItem.confidence).labelKey)}
                    </Badge>
                  )}
                </div>
                {previewItem.createdAt !== '' && (
                  <p className="text-sm text-text-secondary">
                    {t('ask.history.askedAt', { date: formatDateTime(previewItem.createdAt) })}
                  </p>
                )}
                <div>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => {
                      const q = previewItem.question;
                      setPreviewItem(null);
                      void submit(q);
                    }}
                  >
                    {t('ask.history.askAgain')}
                  </Button>
                </div>
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
