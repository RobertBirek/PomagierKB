import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';

/** Kształt GET /api/v1/status (apps/panel-api/src/services/status.ts). */
export interface StatusCockpitDto {
  components: {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'down' | 'unknown';
    detail: string;
    latencyMs: number;
  }[];
  overall: 'ok' | 'warn' | 'down' | 'unknown';
  generatedAt: string;
  breakers: { name: string; state: string; reason?: string | null }[];
}

/** Health cockpit — odświeżany co 15 s (wskaźnik w nagłówku). */
export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: () => apiFetch<StatusCockpitDto>('/api/v1/status'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
