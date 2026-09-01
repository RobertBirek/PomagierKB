/**
 * /ask „Zapytaj bazę" — MOBILE-FIRST czat z bazą wiedzy (PLAN Faza 6 pkt 2).
 * POST /api/v1/ask przez SSE (eventy 'status' {phase} i 'result' AnswerResult
 * z packages/shared/src/answer — trasa powstaje równolegle w Fazie 4/5),
 * feedback POST /api/v1/ask/:answerId/feedback, historia GET /api/v1/ask/history.
 * Uczciwe nie-wiem: noAnswer → jawny stan + automatyczna luka + CTA do /add.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { apiFetch, apiSse, ApiError } from '../lib/api';
import { renderAnswerHtml } from '../lib/markdown';
import { confidenceBadge } from '../lib/confidence';
import { buildAddLinkSearch } from '../lib/prefill';
import { normalizeHistory, type AskHistoryItem } from '../lib/askHistory';
import { can } from '../lib/permissions';
import { useMe } from '../hooks/useMe';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { SafeExternalLink } from '../components/SafeExternalLink';
import { Skeleton } from '../components/Skeleton';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { t, formatDateTime } from '../i18n/t';

// ── Kontrakt /api/v1/ask (AnswerResult + AnswerPhase z shared/answer) ────────

type AskPhase = 'retrieval' | 'generating';

interface AskCitation {
  n: number;
  id: string;
  namespace: string;
  title?: string;
  snippet?: string;
  sourceRef?: string;
}

interface AskResult {
  answer: string;
  citations: AskCitation[];
  confidence: number;
  model: string | null;
  degraded: boolean;
  gapRecorded: boolean;
  noAnswer: boolean;
  answerId: string;
  warnings: string[];
}

interface ChatEntry {
  key: number;
  question: string;
  phase: AskPhase | null;
  result: AskResult | null;
  error: string | null;
}

function parseJsonSafe(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

// ── Feedback 👍/👎 (POST /api/v1/ask/:answerId/feedback) ─────────────────────

function FeedbackControls({ answerId }: { answerId: string }) {
  const toast = useToast();
  const [verdict, setVerdict] = useState<'up' | 'down' | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);

  async function send(v: 'up' | 'down', withComment: string | null): Promise<void> {
    setSending(true);
    try {
      const body: { verdict: 'up' | 'down'; comment?: string } = { verdict: v };
      if (withComment !== null && withComment.trim() !== '') body.comment = withComment.trim();
      await apiFetch(`/api/v1/ask/${encodeURIComponent(answerId)}/feedback`, {
        method: 'POST',
        body,
      });
      setVerdict(v);
      setCommentOpen(false);
      toast.show(v === 'up' ? t('ask.feedback.thanksUp') : t('ask.feedback.thanksDown'), 'ok');
    } catch (err) {
      toast.show(t('error.generic', { message: err instanceof Error ? err.message : String(err) }), 'fail');
    } finally {
      setSending(false);
    }
  }

  if (verdict !== null) {
    return (
      <div className="muted ask-feedback-done">
        {verdict === 'up' ? t('ask.feedback.thanksUp') : t('ask.feedback.thanksDown')}
      </div>
    );
  }

  return (
    <div className="stack ask-feedback">
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={sending}
          aria-label={t('ask.feedback.up')}
          title={t('ask.feedback.up')}
          onClick={() => void send('up', null)}
        >
          👍
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={sending}
          aria-label={t('ask.feedback.down')}
          title={t('ask.feedback.down')}
          onClick={() => setCommentOpen((v) => !v)}
        >
          👎
        </button>
      </div>
      {commentOpen && (
        <div className="stack">
          <label className="muted" htmlFor={`fb-${answerId}`}>
            {t('ask.feedback.whatWrong')}
          </label>
          <textarea
            id={`fb-${answerId}`}
            className="input"
            rows={2}
            value={comment}
            placeholder={t('ask.feedback.commentPlaceholder')}
            onChange={(ev) => setComment(ev.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={sending}
              onClick={() => void send('down', comment)}
            >
              {t('ask.feedback.sendComment')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCommentOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pojedyncza odpowiedź (markdown + cytowania + pewność + feedback) ─────────

interface AnswerViewProps {
  entry: ChatEntry;
  canFeedback: boolean;
  canPropose: boolean;
  onOpenCitation: (citation: AskCitation) => void;
}

function AnswerView({ entry, canFeedback, canPropose, onOpenCitation }: AnswerViewProps) {
  const result = entry.result;
  if (result === null) return null;

  // Delegacja kliknięć w chipy [n] wyrenderowane przez renderAnswerHtml().
  function onAnswerClick(ev: MouseEvent<HTMLDivElement>): void {
    const target = ev.target as HTMLElement;
    const chip = target.closest('[data-cite]');
    if (chip === null) return;
    const n = Number(chip.getAttribute('data-cite'));
    const citation = result?.citations.find((c) => c.n === n);
    if (citation !== undefined) onOpenCitation(citation);
  }

  if (result.noAnswer) {
    const addSearch = buildAddLinkSearch(entry.question);
    return (
      <div className="card ask-no-answer stack">
        <div className="row">
          <span aria-hidden="true">🤷</span>
          <strong>{t('ask.noAnswer.title')}</strong>
        </div>
        {result.answer !== '' && <p className="muted ask-no-answer-text">{result.answer}</p>}
        {result.gapRecorded && <div className="muted">✓ {t('ask.noAnswer.gapRecorded')}</div>}
        {canPropose && addSearch !== null && (
          <div className="row">
            <Link to="/add" search={addSearch} className="btn btn-primary btn-sm">
              {t('ask.noAnswer.addContent')}
            </Link>
          </div>
        )}
      </div>
    );
  }

  const badge = confidenceBadge(result.confidence);
  return (
    <div className="card ask-answer stack">
      <div
        className="ask-answer-body"
        onClick={onAnswerClick}
        // renderAnswerHtml escapuje CAŁE wejście przed transformacją (XSS-safe,
        // testy w test/markdown.test.ts) — generowany HTML jest zaufany.
        dangerouslySetInnerHTML={{ __html: renderAnswerHtml(result.answer, result.citations.length) }}
      />
      <div className="row ask-answer-meta">
        <StatusBadge variant={badge.variant} label={t(badge.labelKey)} status={null} />
        {result.degraded && <span className="muted ask-degraded">{t('ask.degraded')}</span>}
      </div>
      {result.citations.length > 0 && (
        <div className="stack ask-citations">
          <div className="muted">{t('ask.citations.title')}</div>
          <div className="ask-citation-chips">
            {result.citations.map((c) => (
              <button
                key={c.n}
                type="button"
                className="cite-card"
                aria-label={t('ask.citations.chipLabel', { n: c.n })}
                onClick={() => onOpenCitation(c)}
              >
                <span className="cite-chip-n">[{c.n}]</span>
                <span className="cite-card-title">{c.title ?? c.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {canFeedback && <FeedbackControls answerId={result.answerId} />}
    </div>
  );
}

// ── Historia pytań użytkownika (GET /api/v1/ask/history) ─────────────────────

interface HistoryListProps {
  onPreview: (item: AskHistoryItem) => void;
}

function HistoryList({ onPreview }: HistoryListProps) {
  const query = useQuery({
    queryKey: ['ask-history'],
    queryFn: () => apiFetch<unknown>('/api/v1/ask/history'),
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="stack">
        <Skeleton height="18px" />
        <Skeleton height="18px" width="70%" />
      </div>
    );
  }
  // Trasa historii powstaje równolegle (Faza 4) — błąd nie psuje czatu.
  if (query.isError) return null;
  const items = normalizeHistory(query.data);
  if (items.length === 0) return <p className="muted">{t('ask.history.empty')}</p>;

  return (
    <ul className="ask-history-list">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="ask-history-item" onClick={() => onPreview(item)}>
            <span className="ask-history-question">{item.question}</span>
            <span className="row ask-history-meta">
              {item.noAnswer && (
                <StatusBadge variant="warn" label={t('ask.history.noAnswerBadge')} status={null} />
              )}
              {item.verdict === 'up' && <span aria-hidden="true">👍</span>}
              {item.verdict === 'down' && <span aria-hidden="true">👎</span>}
              {item.createdAt !== '' && <span className="muted">{formatDateTime(item.createdAt)}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── Strona ───────────────────────────────────────────────────────────────────

export function AskPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const role = me.data?.user.role;
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [openCitation, setOpenCitation] = useState<AskCitation | null>(null);
  const [previewItem, setPreviewItem] = useState<AskHistoryItem | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const nextKey = useRef(1);

  // Autofocus tylko na desktopie (mobile: nie wywołuj klawiatury od razu).
  useEffect(() => {
    if (window.matchMedia('(min-width: 769px)').matches) inputRef.current?.focus();
  }, []);

  // Przerwij strumień przy odmontowaniu strony.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (entries.length > 0) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  const patchEntry = useCallback((key: number, patch: Partial<ChatEntry>) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }, []);

  const submit = useCallback(
    async (rawQuestion: string): Promise<void> => {
      const q = rawQuestion.trim();
      if (q === '' || busy) return;
      // Kontrakt POST /api/v1/ask: question minLength 5 — komunikat PL zamiast 400.
      if (q.length < 5) {
        setEntries((prev) => [
          ...prev,
          { key: nextKey.current++, question: q, phase: null, result: null, error: t('ask.tooShort') },
        ]);
        return;
      }
      const key = nextKey.current++;
      setEntries((prev) => [...prev, { key, question: q, phase: null, result: null, error: null }]);
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
              const result = parseJsonSafe(ev.data) as AskResult | null;
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
        if (err instanceof DOMException && err.name === 'AbortError') return;
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

  const canFeedback = can(role, 'feedback');
  const canPropose = can(role, 'propose');

  return (
    <div className="ask-page stack">
      <form className="card stack ask-form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="ask-input">
          {t('ask.inputLabel')}
        </label>
        <textarea
          id="ask-input"
          ref={inputRef}
          className="input ask-input"
          rows={3}
          value={question}
          placeholder={t('ask.inputPlaceholder')}
          onChange={(ev) => setQuestion(ev.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <div className="row">
          <span className="grow" />
          <button type="submit" className="btn btn-primary" disabled={busy || question.trim() === ''}>
            {t('ask.send')}
          </button>
        </div>
      </form>

      {entries.length === 0 && (
        <EmptyState icon="💬" title={t('ask.emptyTitle')} description={t('ask.emptyDescription')} />
      )}

      <div className="stack ask-thread">
        {entries.map((entry) => (
          <div key={entry.key} className="stack ask-exchange">
            <div className="ask-question">{entry.question}</div>
            {entry.phase !== null && (
              <div className="row ask-phase" role="status">
                <span className="ask-phase-spinner" aria-hidden="true" />
                {t(entry.phase === 'retrieval' ? 'ask.phase.retrieval' : 'ask.phase.generating')}
              </div>
            )}
            {entry.error !== null && (
              <div className="card ask-error">{t('ask.error', { message: entry.error })}</div>
            )}
            <AnswerView
              entry={entry}
              canFeedback={canFeedback}
              canPropose={canPropose}
              onOpenCitation={setOpenCitation}
            />
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <section className="stack">
        <h2 className="ask-section-title">{t('ask.history.title')}</h2>
        <HistoryList onPreview={setPreviewItem} />
      </section>

      <Drawer
        open={openCitation !== null}
        onClose={() => setOpenCitation(null)}
        title={openCitation !== null ? t('ask.citation.drawerTitle', { n: openCitation.n }) : ''}
      >
        {openCitation !== null && (
          <div className="stack">
            <strong>{openCitation.title ?? openCitation.id}</strong>
            <div>
              <span className="muted">{t('ask.citation.namespace')}: </span>
              {openCitation.namespace}
            </div>
            <div className="stack">
              <span className="muted">{t('ask.citation.snippet')}</span>
              {openCitation.snippet !== undefined && openCitation.snippet !== '' ? (
                <blockquote className="ask-snippet">{openCitation.snippet}</blockquote>
              ) : (
                <p className="muted">{t('ask.citation.noSnippet')}</p>
              )}
            </div>
            {openCitation.sourceRef !== undefined && openCitation.sourceRef !== '' && (
              <div className="stack">
                <span className="muted">{t('ask.citation.sourceRef')}</span>
                <SafeExternalLink href={openCitation.sourceRef}>
                  {openCitation.sourceRef}
                </SafeExternalLink>
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        open={previewItem !== null}
        onClose={() => setPreviewItem(null)}
        title={t('ask.history.preview')}
      >
        {previewItem !== null && (
          <div className="stack">
            <p className="ask-history-preview-question">{previewItem.question}</p>
            <div className="row">
              {previewItem.noAnswer ? (
                <StatusBadge variant="warn" label={t('ask.history.noAnswerBadge')} status={null} />
              ) : (
                <StatusBadge
                  variant={confidenceBadge(previewItem.confidence).variant}
                  label={t(confidenceBadge(previewItem.confidence).labelKey)}
                  status={null}
                />
              )}
            </div>
            {previewItem.createdAt !== '' && (
              <p className="muted">{t('ask.history.askedAt', { date: formatDateTime(previewItem.createdAt) })}</p>
            )}
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  const q = previewItem.question;
                  setPreviewItem(null);
                  void submit(q);
                }}
              >
                {t('ask.history.askAgain')}
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
