/**
 * Tabs v2 — na Radix Tabs; aktywna zakładka z podkreśleniem 2px (accent).
 *
 * Użycie (stan lokalny):
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabsList>
 *       <TabsTrigger value="keys">Klucze</TabsTrigger>
 *       <TabsTrigger value="profiles">Profile</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="keys">…</TabsContent>
 *     <TabsContent value="profiles">…</TabsContent>
 *   </Tabs>
 *
 * Wzorzec URL-sync z TanStack Router (zakładka w search-params, bez wpisu
 * w historii — replace: true):
 *   const { tab } = Route.useSearch();          // validateSearch: tab ?? 'keys'
 *   const navigate = Route.useNavigate();
 *   <Tabs
 *     value={tab}
 *     onValueChange={(value) =>
 *       navigate({ search: (prev) => ({ ...prev, tab: value }), replace: true })
 *     }
 *   >…</Tabs>
 */
import { Tabs as RadixTabs } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return <RadixTabs.List {...props} className={cn('flex gap-1 border-b border-border', className)} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      {...props}
      className={cn(
        'relative h-9 rounded-t-md px-3 text-sm text-text-secondary transition-colors hover:text-text',
        'data-[state=active]:font-medium data-[state=active]:text-text',
        // Podkreślenie 2px — zawsze w DOM, aktywne przez opacity (płynne przejście).
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
        'after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  // outline-none — panel dostaje fokus po strzałkach, ring globalny byłby szumem.
  return <RadixTabs.Content {...props} className={cn('pt-4 outline-none focus-visible:outline-none', className)} />;
}
