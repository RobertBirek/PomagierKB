import type { CSSProperties } from 'react';
import { cn } from './cn';

export interface SkeletonProps {
  className?: string;
  width?: string;
  height?: string;
}

/** Placeholder ładowania v2 (legacy components/Skeleton.tsx zostaje do migracji). */
export function Skeleton({ className, width, height }: SkeletonProps) {
  const style: CSSProperties = {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
  return (
    <div
      className={cn('animate-pulse rounded-md bg-surface-3', className)}
      style={style}
      aria-hidden="true"
    />
  );
}

export interface SkeletonTextProps {
  /** Liczba linii (ostatnia skrócona). */
  lines?: number;
  className?: string;
}

export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-3.5 animate-pulse rounded-md bg-surface-3',
            i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full',
          )}
        />
      ))}
    </div>
  );
}

/** Szkielet karty: nagłówek + kilka linii treści. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-surface p-4', className)}
      aria-hidden="true"
    >
      <div className="mb-3 h-4 w-2/5 animate-pulse rounded-md bg-surface-3" />
      <SkeletonText lines={3} />
    </div>
  );
}
