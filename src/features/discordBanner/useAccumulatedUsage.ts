import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';

const TICK_MS = 30_000; // flush every 30s

/**
 * Tracks total accumulated app usage time across sessions, persisted via
 * authStore (zustand persist → localStorage). Counts time for as long as
 * the app process is running, regardless of window focus/visibility.
 * Mount once near the app root (e.g. AppShell).
 */
export function useAccumulatedUsage(): void {
  const lastTickRef = useRef<number | null>(null);
  const addUsageMs = useAuthStore(s => s.addDiscordBannerUsageMs);

  useEffect(() => {
    lastTickRef.current = Date.now();

    const flush = (): void => {
      const now = Date.now();
      const delta = now - (lastTickRef.current ?? now);
      lastTickRef.current = now;
      addUsageMs(delta);
    };

    const interval = window.setInterval(flush, TICK_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [addUsageMs]);
}
