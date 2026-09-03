import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { cn } from './cn';

export interface TooltipProviderProps {
  children: ReactNode;
  delayDuration?: number;
}

/** Provider tooltipów (raz, wysoko w drzewie — np. w main.tsx). */
export function TooltipProvider({ children, delayDuration = 300 }: TooltipProviderProps) {
  return <RadixTooltip.Provider delayDuration={delayDuration}>{children}</RadixTooltip.Provider>;
}

export interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  /** Trigger — pojedynczy element (asChild, przejmuje propsy Radixa). */
  children: ReactElement;
}

/** Tooltip bez strzałki: ciemny (bg-text/text-bg — odwrócone tokeny). */
export function Tooltip({ content, side, className, children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          {...(side !== undefined ? { side } : {})}
          className={cn(
            'z-(--z-tooltip) max-w-72 rounded-md bg-text px-2 py-1 text-xs text-bg shadow-md',
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
