/**
 * Karta odpowiedzi /ask v2: Markdown z cytowaniami, plakietka pewności,
 * degraded → dyskretny Alert, noAnswer → karta SearchX + CTA /add,
 * kopiowanie do schowka (hover), feedback 👍/👎 (Popover z komentarzem).
 * Werdykt feedbacku jest trzymany we wpisie wątku (persystencja w
 * sessionStorage robi strona) — komponent tylko wysyła POST i raportuje.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Copy, SearchX, ThumbsDown, ThumbsUp } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { confidenceBadge } from '@/lib/confidence';
import { buildAddLinkSearch } from '@/lib/prefill';
import type { ThreadCitation, ThreadEntry, ThreadResult } from '@/lib/askThread';
import { Markdown } from '@/components/Markdown';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button, buttonVariants, IconButton } from '@/ui/button';
import { Card } from '@/ui/card';
import { cn } from '@/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Select } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import { Tooltip } from '@/ui/tooltip';
import { useToast } from '@/ui/toast';
import { t, type PlKey } from '@/i18n/t';

// ── Feedback (POST /api/v1/ask/:answerId/feedback) ───────────────────────────

interface FeedbackControlsProps {
  answerId: string;
  verdict: 'up' | 'down' | null;
  onSaved: (verdict: 'up' | 'down') => void;
}

/**
 * Kategorie przyczyny negatywnej oceny. Każda wskazuje INNĄ naprawę, dlatego lista jest
 * krótka i rozłączna — dłuższa zmusiłaby użytkownika do zgadywania, a wtedy dane byłyby
 * gorsze niż ich brak. Kolejność od najczęstszej.
 */
const FEEDBACK_CATEGORIES = [
  'retrieval_miss',
  'incomplete',
  'hallucination',
  'outdated',
  'citation_error',
  'wrong_kb',
  'other',
] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const CATEGORY_LABEL: Record<FeedbackCategory, PlKey> = {
  retrieval_miss: 'ask.feedback.cat.retrievalMiss',
  incomplete: 'ask.feedback.cat.incomplete',
  hallucination: 'ask.feedback.cat.hallucination',
  outdated: 'ask.feedback.cat.outdated',
  citation_error: 'ask.feedback.cat.citationError',
  wrong_kb: 'ask.feedback.cat.wrongKb',
  other: 'ask.feedback.cat.other',
};

function FeedbackControls({ answerId, verdict, onSaved }: FeedbackControlsProps) {
  const toast = useToast();
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [sending, setSending] = useState(false);

  async function send(
    v: 'up' | 'down',
    withComment: string | null,
    withCategory: FeedbackCategory | '' = '',
  ): Promise<void> {
    setSending(true);
    try {
      const body: { verdict: 'up' | 'down'; comment?: string; category?: FeedbackCategory } = {
        verdict: v,
      };
      if (withComment !== null && withComment.trim() !== '') body.comment = withComment.trim();
      if (withCategory !== '') body.category = withCategory;
      await apiFetch(`/api/v1/ask/${encodeURIComponent(answerId)}/feedback`, { method: 'POST', body });
      setCommentOpen(false);
      onSaved(v);
      toast.show(v === 'up' ? t('ask.feedback.thanksUp') : t('ask.feedback.thanksDown'), 'ok');
    } catch (err) {
      toast.show(errorMessage(err), 'fail');
    } finally {
      setSending(false);
    }
  }

  if (verdict !== null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
        {verdict === 'up' ? (
          <ThumbsUp size={14} className="text-ok" aria-hidden="true" />
        ) : (
          <ThumbsDown size={14} className="text-fail" aria-hidden="true" />
        )}
        {verdict === 'up' ? t('ask.feedback.thanksUp') : t('ask.feedback.thanksDown')}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Tooltip content={t('ask.feedback.up')}>
        <IconButton
          aria-label={t('ask.feedback.up')}
          size="icon-sm"
          disabled={sending}
          onClick={() => void send('up', null)}
        >
          <ThumbsUp size={15} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <Popover open={commentOpen} onOpenChange={setCommentOpen}>
        <Tooltip content={t('ask.feedback.down')}>
          <PopoverTrigger asChild>
            <IconButton aria-label={t('ask.feedback.down')} size="icon-sm" disabled={sending}>
              <ThumbsDown size={15} aria-hidden="true" />
            </IconButton>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent align="start" className="w-80">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text" htmlFor={`fb-cat-${answerId}`}>
              {t('ask.feedback.whatWrong')}
            </label>
            {/* Kategoria PRZED komentarzem: jedno kliknięcie daje dane, po których da się
                działać, nawet gdy nikomu nie chce się pisać zdania. */}
            <Select
              id={`fb-cat-${answerId}`}
              value={category}
              onChange={(ev) => setCategory(ev.target.value as FeedbackCategory | '')}
            >
              <option value="">{t('ask.feedback.cat.none')}</option>
              {FEEDBACK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(CATEGORY_LABEL[c])}
                </option>
              ))}
            </Select>
            <Textarea
              id={`fb-${answerId}`}
              rows={3}
              value={comment}
              placeholder={t('ask.feedback.commentPlaceholder')}
              onChange={(ev) => setComment(ev.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCommentOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={sending}
                onClick={() => void send('down', comment, category)}
              >
                {t('ask.feedback.sendComment')}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Karta odpowiedzi ─────────────────────────────────────────────────────────

export interface AnswerCardProps {
  entry: ThreadEntry;
  canFeedback: boolean;
  canPropose: boolean;
  onOpenCitation: (citation: ThreadCitation) => void;
  onVerdictSaved: (entryKey: number, verdict: 'up' | 'down') => void;
}

export function AnswerCard({ entry, canFeedback, canPropose, onOpenCitation, onVerdictSaved }: AnswerCardProps) {
  const toast = useToast();
  const result: ThreadResult | null = entry.result;
  if (result === null) return null;

  if (result.noAnswer) {
    const addSearch = buildAddLinkSearch(entry.question);
    return (
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <SearchX size={18} className="shrink-0 text-text-tertiary" aria-hidden="true" />
          <strong className="text-sm font-semibold text-text">{t('ask.noAnswer.title')}</strong>
        </div>
        {result.answer !== '' && <p className="text-sm text-text-secondary">{result.answer}</p>}
        {result.gapRecorded && <Alert variant="info">{t('ask.noAnswer.gapRecorded')}</Alert>}
        {canPropose && addSearch !== null && (
          <div>
            <Link to="/add" search={addSearch} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
              {t('ask.noAnswer.addContent')}
            </Link>
          </div>
        )}
      </Card>
    );
  }

  const badge = confidenceBadge(result.confidence);

  function copyAnswer(): void {
    if (result === null) return;
    navigator.clipboard
      .writeText(result.answer)
      .then(() => toast.show(t('common.copied'), 'ok'))
      .catch(() => toast.show(t('ui.copyManually'), 'warn'));
  }

  return (
    <Card className="group relative flex flex-col gap-3 p-4">
      <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip content={t('ask.copyAnswer')}>
          <IconButton aria-label={t('ask.copyAnswer')} size="icon-sm" onClick={copyAnswer}>
            <Copy size={15} aria-hidden="true" />
          </IconButton>
        </Tooltip>
      </div>
      <Markdown
        text={result.answer}
        withCitations
        citeCount={result.citations.length}
        onCitationClick={(n) => {
          const citation = result.citations.find((c) => c.n === n);
          if (citation !== undefined) onOpenCitation(citation);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={badge.variant}>{t(badge.labelKey)}</Badge>
      </div>
      {result.degraded && <Alert variant="info">{t('ask.degraded')}</Alert>}
      {result.citations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-xs text-text-tertiary">{t('ask.citations.title')}</div>
          <div className="flex flex-wrap gap-1.5">
            {result.citations.map((c) => (
              <button
                key={c.n}
                type="button"
                aria-label={t('ask.citations.chipLabel', { n: c.n })}
                onClick={() => onOpenCitation(c)}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1',
                  'text-left text-xs text-text-secondary transition-colors hover:bg-surface-3 hover:text-text',
                )}
              >
                <span className="shrink-0 font-mono text-2xs text-accent">[{c.n}]</span>
                <span className="truncate">{c.title ?? c.id}</span>
                {/* Sekcja dokumentu — bez niej cytowanie wskazuje fragment, a nie miejsce
                    w dokumencie, i nie da się ocenić, czy zła odpowiedź to wina modelu,
                    retrievalu czy podziału źródła. */}
                {c.sectionHeading !== undefined && c.sectionHeading !== '' && (
                  <span className="truncate text-text-tertiary">› {c.sectionHeading}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {canFeedback && (
        <FeedbackControls
          answerId={result.answerId}
          verdict={entry.verdict}
          onSaved={(v) => onVerdictSaved(entry.key, v)}
        />
      )}
    </Card>
  );
}
