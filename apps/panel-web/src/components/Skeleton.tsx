export interface SkeletonProps {
  width?: string;
  height?: string;
  className?: string;
}

/** Placeholder ładowania (shimmer). */
export function Skeleton({ width = '100%', height = '16px', className = '' }: SkeletonProps) {
  return <div className={`skeleton ${className}`} style={{ width, height }} aria-hidden="true" />;
}
