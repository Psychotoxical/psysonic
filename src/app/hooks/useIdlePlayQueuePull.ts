import { useEffect, useRef } from 'react';
import { applyServerPlayQueue } from '@/features/playback/store/applyServerPlayQueue';
import { useAuthStore } from '@/store/authStore';
import { useOrbitStore } from '@/features/orbit';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  getPlaybackIdleSinceMs,
  isIdleQueuePullSuspended,
  isQueueNaturallyEnded,
  isPlaybackIdleLongEnough,
  markPlaybackIdle,
} from '@/features/playback/store/queuePlaybackIdle';
import { hasPendingQueueSync } from '@/features/playback/store/queueSync';
import type { ConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { canAutoIdlePlayQueuePull } from '@/app/hooks/usePlayQueueSyncLedState';

const IDLE_THRESHOLD_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;

/** Background pull when paused/stopped long enough on a single-server, in-sync browse context. */
export function useIdlePlayQueuePull(status: ConnectionStatus) {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const orbitRole = useOrbitStore(s => s.role);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!isPlaying && getPlaybackIdleSinceMs() === 0) {
      markPlaybackIdle();
    }
  }, [isPlaying]);

  useEffect(() => {
    if (!canAutoIdlePlayQueuePull(status, orbitRole)) return;

    const tick = () => {
      if (inFlightRef.current) return;
      if (!canAutoIdlePlayQueuePull(status, orbitRole)) return;
      if (isPlaying) return;
      if (!isPlaybackIdleLongEnough(IDLE_THRESHOLD_MS)) return;
      if (isIdleQueuePullSuspended()) return;
      if (isQueueNaturallyEnded()) return;
      if (hasPendingQueueSync()) return;
      if (!activeServerId) return;

      inFlightRef.current = true;
      void applyServerPlayQueue(activeServerId, { mode: 'idle', preferServerPosition: true })
        .finally(() => {
          inFlightRef.current = false;
        });
    };

    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeServerId, isPlaying, orbitRole, status]);
}
