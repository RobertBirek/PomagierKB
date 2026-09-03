/**
 * Cienki re-eksport — implementacja przeniesiona do design systemu v2
 * (src/ui/toast.tsx). Stary kontrakt useToast().show(message, kind?) bez zmian;
 * nowe strony importują bezpośrednio z '@/ui/toast' (dodatkowo push/dismiss).
 */
export { ToastProvider, useToast } from '@/ui/toast';
export type { ToastApi, ToastKind } from '@/ui/toast';
