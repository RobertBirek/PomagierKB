import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/t';
import { cn } from './cn';
import { fieldControlClasses } from './input';

export interface Debouncer {
  /** Zaplanuj wywołanie fn po delay ms (resetuje poprzedni timer). */
  schedule: (fn: () => void) => void;
  /** Odwołaj zaplanowane wywołanie. */
  cancel: () => void;
}

/** Czysta fabryka debouncera — logika testowalna bez DOM (fake timers). */
export function createDebouncer(delay: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(fn) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delay);
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export interface SearchInputProps {
  /** Wartość kontrolowana (synchronizuje pole przy zmianie z zewnątrz). */
  value?: string;
  defaultValue?: string;
  /** Wywoływane po delay ms od ostatniej zmiany (czyszczenie: natychmiast). */
  onDebouncedChange: (value: string) => void;
  delay?: number;
  placeholder?: string;
  className?: string;
}

/** Pole wyszukiwania: ikona lupy, debounce, przycisk czyszczenia. */
export function SearchInput({
  value,
  defaultValue,
  onDebouncedChange,
  delay = 300,
  placeholder,
  className,
}: SearchInputProps) {
  const [text, setText] = useState(value ?? defaultValue ?? '');
  const debouncer = useMemo(() => createDebouncer(delay), [delay]);

  // Cleanup timera przy odmontowaniu / zmianie delay.
  useEffect(() => () => debouncer.cancel(), [debouncer]);

  // Synchronizacja z wartością kontrolowaną z zewnątrz.
  useEffect(() => {
    if (value !== undefined) setText(value);
  }, [value]);

  const handleChange = (next: string) => {
    setText(next);
    debouncer.schedule(() => onDebouncedChange(next));
  };

  const handleClear = () => {
    debouncer.cancel();
    setText('');
    onDebouncedChange('');
  };

  return (
    <div className={cn('relative', className)}>
      <Search
        size={15}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
        aria-hidden="true"
      />
      <input
        type="text"
        role="searchbox"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        className={cn(fieldControlClasses, 'h-8 pl-8 pr-8')}
        {...(placeholder !== undefined ? { placeholder } : {})}
      />
      {text !== '' ? (
        <button
          type="button"
          aria-label={t('ui.clear')}
          onClick={handleClear}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
