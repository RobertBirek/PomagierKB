import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Wspólny QueryClient. Konwencje kluczy (dla agentów stron):
 * ['me'] | ['status'] | ['kbs'] | ['kbs', ns] | ['drafts', filters] |
 * ['drafts', id] | ['action', id] (refetchInterval 2000 dopóki running) |
 * ['gaps', filters] | ['mcp', ...] | ['settings'] | ['ask-history'].
 * Mutacje inwalidują klucz zasobu (invalidateQueries({queryKey:[...]})).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Błędy 4xx (uprawnienia, walidacja) nie znikną od ponowienia.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});
