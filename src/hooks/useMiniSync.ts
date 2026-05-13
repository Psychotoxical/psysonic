import { useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { useWindowVisibility } from './useWindowVisibility';
import type { MiniSyncPayload } from '../utils/miniPlayerBridge';

interface ProgressPayload {
  current_time: number;
  duration: number;
}

interface Args {
  onSync: (s: MiniSyncPayload) => void;
  onProgress: (currentTime: number, duration: number) => void;
  onEnded: () => void;
}

/** Bridge wiring between the mini webview and the main window / Rust:
 *  - emits mini:ready on mount + on focus (Windows pre-creates the mini so the
 *    mount-time emit can race the main bridge; refocus guarantees re-sync)
 *  - listens for mini:sync, audio:progress (skipped while hidden), audio:ended
 *  - cleans up on unmount */
export function useMiniSync({ onSync, onProgress, onEnded }: Args) {
  const isHidden = useWindowVisibility();
  const hiddenRef = useRef(false);
  useEffect(() => { hiddenRef.current = isHidden; }, [isHidden]);

  useEffect(() => {
    emit('mini:ready', {}).catch(() => {});
    const onFocus = () => { emit('mini:ready', {}).catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    const unSync = listen<MiniSyncPayload>('mini:sync', (e) => onSync(e.payload));
    const unProgress = listen<ProgressPayload>('audio:progress', (e) => {
      if (hiddenRef.current || window.__psyHidden) return;
      onProgress(e.payload.current_time, e.payload.duration);
    });
    const unEnded = listen('audio:ended', () => onEnded());
    return () => {
      unSync.then(fn => fn()).catch(() => {});
      unProgress.then(fn => fn()).catch(() => {});
      unEnded.then(fn => fn()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
