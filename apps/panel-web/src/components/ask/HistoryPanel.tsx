/**
 * Panel historii pytań /ask v2 (aside ≥1280px / Sheet poniżej):
 * GET /api/v1/ask/history + filtr kliencki (SearchInput) + grupowanie dat
 * (Dzisiaj/Wczoraj/Ten tydzień/Starsze — czysta funkcja groupHistory).
 * Błąd historii JAWNY: Alert warn + przycisk ponowienia (koniec return null).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { normalizeHistory, type AskHistoryItem } from '@/lib/askHistory';
import { groupHistory, type HistoryGroupId } from '@/lib/askThread';
import { Alert } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { SearchInput } from '@/ui/search-input';
import { SkeletonText } from '@/ui/skeleton';
import { t, formatDateTime, type PlKey } from '@/i18n/t';

const GROUP_LABEL_KEY: Record<HistoryGroupId, PlKey> = {
  today: 'ask.history.group.today',
  yesterday: 'ask.history.group.yesterday',
  week: 'ask.history.group.week',
  older: 'ask.history.group.older',
};

export interface HistoryPanelProps {
  onPreview: (item: AskHistoryItem) => void;
}

export function HistoryPanel({ onPreview }: HistoryPanelProps) {
  const [filter, setFilter] = useState('');
  const query = useQuery({
    queryKey: ['ask-history'],
    queryFn: () => apiFetch<unknown>('/api/v1/ask/history'),
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return <SkeletonText lines={5} />;
  }

  if (query.isError) {
    return (
      <Alert variant="warn" title={t('ask.history.error')}>
        <Button size="sm" className="mt-2" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </Alert>
    );
  }

  const items = normalizeHistory(query.data);
  if (items.length === 0) {
    return <p className="text-sm text-text-secondary">{t('ask.history.empty')}</p>;
  }

  const needle = filter.trim().toLowerCase();
  const filtered = needle === '' ? items : items.filter((i) => i.question.toLowerCase().includes(needle));
  const groups = groupHistory(filtered, new Date());

  return (
    <div className="flex flex-col gap-3">
      <SearchInput
        value={filter}
        onDebouncedChange={setFilter}
        placeholder={t('ask.history.searchPlaceholder')}
      />
      {filtered.length === 0 && <p className="text-sm text-text-secondary">{t('ask.history.noResults')}</p>}
      {groups.map((group) => (
        <section key={group.id} className="flex flex-col gap-1">
          <h3 className="px-1 text-2xs font-medium uppercase tracking-wide text-text-tertiary">
            {t(GROUP_LABEL_KEY[group.id])}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onPreview(item)}
                  className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="line-clamp-2 text-sm text-text">{item.question}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {item.noAnswer && <Badge variant="warn">{t('ask.history.noAnswerBadge')}</Badge>}
                    {item.verdict === 'up' && (
                      <ThumbsUp size={12} className="text-ok" aria-label={t('ask.feedback.up')} />
                    )}
                    {item.verdict === 'down' && (
                      <ThumbsDown size={12} className="text-fail" aria-label={t('ask.feedback.down')} />
                    )}
                    {item.createdAt !== '' && (
                      <span className="text-2xs text-text-tertiary">{formatDateTime(item.createdAt)}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
