import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { recordCoverProgress } from '../utils/perf/coverPerfStore';

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
