import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { coverGetPipelineQueueStats } from '@/lib/api/coverCache';
import { recordCoverProgress, recordCoverUiTotal } from '@/lib/perf/coverPerfStore';

/** How often to sample the backend's cumulative on-demand (UI) ensure count. */
const UI_POLL_MS = 1000;

type CoverLibraryProgressPayload = {
  serverIndexKey?: string;
  done?: number;
  total?: number;
  pending?: number;
};

/** Wire Rust `cover:library-progress` events into the cover perf store. */
export function useCoverPerfListener(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<CoverLibraryProgressPayload>('cover:library-progress', ({ payload }) => {
      if (cancelled || typeof payload?.done !== 'number') return;
      recordCoverProgress({
        done: payload.done,
        total: payload.total,
        pending: payload.pending,
      });
    })
      .then(fn => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active]);
}

/**
 * Poll the backend's cumulative on-demand (UI) ensure total so the cover store
 * can derive a per-minute rate. Mount once (always-mounted probe hook) to avoid
 * duplicate polling.
 */
export function useCoverUiThroughputPoll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const sample = (): void => {
      void coverGetPipelineQueueStats()
        .then(stats => {
          if (!cancelled) recordCoverUiTotal(stats.uiEnsuredTotal);
        })
        .catch(() => {});
    };
    sample();
    const timer = window.setInterval(sample, UI_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);
}
