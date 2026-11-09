import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { retryDelayMs, shouldRetry } from '../lib/retry';
import { api, ApiError, streamUrl, type Auth, type AnalyticsParams } from './client';
import type { Tick } from './types';

export function usePublicSession(code: string | undefined) {
  return useQuery({
    queryKey: ['session', code, 'public'],
    queryFn: () => api.getSession(code as string),
    enabled: !!code,

    retry: (count, e) => !(e instanceof ApiError && e.status === 429) && shouldRetry(count, e),
    retryDelay: retryDelayMs,
  });
}

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => api.meta(),
    staleTime: Infinity,
    retry: false,
  });
}

export function useAdminSession(code: string | undefined, auth: Auth | null) {
  return useQuery({
    queryKey: ['session', code, 'admin', auth?.key],
    queryFn: () => api.getAdminSession(code as string, auth as Auth),
    enabled: !!code && !!auth,
  });
}

export function useAnalytics(
  code: string | undefined,
  auth: Auth | null,
  params: AnalyticsParams | null,
  opts: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: ['session', code, 'analytics', params],
    queryFn: ({ signal }) => api.getAnalytics(code as string, auth, params as AnalyticsParams, signal),
    enabled: !!code && !!params && (opts.enabled ?? true),
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval ?? false,
  });
}

export function useCompare(
  code: string | undefined,
  auth: Auth | null,
  questionId: string | undefined,
  groupBy: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['session', code, 'compare', questionId, groupBy],
    queryFn: ({ signal }) => api.getCompare(code as string, auth, questionId as string, groupBy as string, signal),
    enabled: !!code && !!questionId && !!groupBy && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useLabels(code: string | undefined, auth: Auth | null, questionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['labels', code, questionId],
    queryFn: () => api.getLabels(code as string, auth as Auth, questionId as string),
    enabled: !!code && !!auth && !!questionId && enabled,
  });
}

export type LiveState = 'connecting' | 'live' | 'polling';

export function useLive(code: string | undefined, key: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const [tick, setTick] = useState<Tick | null>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const lastVersion = useRef<number | null>(null);

  useEffect(() => {
    if (!code || !enabled) return;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['session', code] });
    };
    const startPolling = () => {
      if (pollTimer || disposed) return;
      setState('polling');
      pollTimer = setInterval(refresh, 3000);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
      return () => {
        disposed = true;
        stopPolling();
      };
    }

    es = new EventSource(streamUrl(code, key));
    es.onopen = () => {
      stopPolling();
      setState('live');
    };
    es.addEventListener('tick', (ev) => {
      try {
        const t = JSON.parse((ev as MessageEvent<string>).data) as Tick;
        setTick(t);
        setState('live');
        stopPolling();
        if (lastVersion.current !== t.version) {
          lastVersion.current = t.version;
          refresh();
        }
      } catch {
        return;
      }
    });
    es.onerror = () => {
      startPolling();
      if (es && es.readyState === EventSource.CLOSED) {

        es.close();
      }
    };
    return () => {
      disposed = true;
      stopPolling();
      es?.close();
    };
  }, [code, key, enabled, qc]);

  return { tick, state };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
