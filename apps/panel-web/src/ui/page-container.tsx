/** PageContainer — szerokość treści strony (mx-auto). */
import type { ReactNode } from 'react';
import { cn } from '@/ui/cn';

export type PageWidth = 'full' | 'prose' | 'form' | 'settings';

export interface PageContainerProps {
  width?: PageWidth;
  children: ReactNode;
  className?: string;
}

const WIDTH_CLASS: Record<PageWidth, string> = {
  full: '',
  prose: 'max-w-[720px]',
  form: 'max-w-[840px]',
  settings: 'max-w-[960px]',
};

export function PageContainer({ width = 'full', children, className }: PageContainerProps) {
  return <div className={cn('mx-auto w-full', WIDTH_CLASS[width], className)}>{children}</div>;
}
