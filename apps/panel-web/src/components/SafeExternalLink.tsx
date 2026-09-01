import type { ReactNode } from 'react';

/** Czy URL wolno linkować (wyłącznie http/https — nigdy javascript:/data:). */
export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface SafeExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** Link zewnętrzny: tylko http/https, zawsze noopener+noreferrer; inny protokół → zwykły tekst. */
export function SafeExternalLink({ href, children, className }: SafeExternalLinkProps) {
  if (!isSafeHref(href)) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
