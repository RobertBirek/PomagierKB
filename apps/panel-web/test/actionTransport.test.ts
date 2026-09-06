/**
 * D13-05: czyste zakończenie strumienia SSE bez statusu terminalnego musi
 * uruchomić fallback na odpytywanie — inaczej pasek postępu wisi na „running"
 * po akcji, która dawno się zakończyła (także błędem).
 */
import { describe, expect, it } from 'vitest';
import {
  asRunStatus,
  isTerminalActionStatus,
  shouldFallbackToPolling,
  type ActionRunStatus,
} from '../src/lib/actionTransport';

describe('asRunStatus()', () => {
  it('przepuszcza znane statusy, resztę mapuje na unknown', () => {
    expect(asRunStatus('running')).toBe('running');
    expect(asRunStatus('success')).toBe('success');
    expect(asRunStatus('error')).toBe('error');
    expect(asRunStatus('cancelled')).toBe('cancelled');
    expect(asRunStatus('cokolwiek')).toBe('unknown');
    expect(asRunStatus(undefined)).toBe('unknown');
    expect(asRunStatus(7)).toBe('unknown');
  });
});

describe('isTerminalActionStatus()', () => {
  it('terminalne: success/error/cancelled', () => {
    expect(isTerminalActionStatus('success')).toBe(true);
    expect(isTerminalActionStatus('error')).toBe(true);
    expect(isTerminalActionStatus('cancelled')).toBe(true);
    expect(isTerminalActionStatus('running')).toBe(false);
    expect(isTerminalActionStatus('unknown')).toBe(false);
  });
});

describe('shouldFallbackToPolling()', () => {
  it('strumień urwany bez statusu terminalnego → przechodzimy na polling', () => {
    expect(shouldFallbackToPolling({ stopped: false, status: 'running' })).toBe(true);
    expect(shouldFallbackToPolling({ stopped: false, status: 'unknown' })).toBe(true);
  });

  it('status terminalny → NIE odpytujemy dalej (akcja skończona)', () => {
    for (const status of ['success', 'error', 'cancelled'] as ActionRunStatus[]) {
      expect(shouldFallbackToPolling({ stopped: false, status })).toBe(false);
    }
  });

  it('hook odmontowany → nic nie startujemy', () => {
    expect(shouldFallbackToPolling({ stopped: true, status: 'running' })).toBe(false);
    expect(shouldFallbackToPolling({ stopped: true, status: 'success' })).toBe(false);
  });
});
