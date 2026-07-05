import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { pullPlayQueueFromActiveServer } from '@/features/playback/store/applyServerPlayQueue';
import { useAuthStore } from '@/store/authStore';
import { useOrbitStore } from '@/features/orbit';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { getPlaybackServerId, queueIsMultiServer } from '@/features/playback/utils/playback/playbackServer';
import {
  getIdleQueuePullSuspendedSnapshot,
  subscribeIdleQueuePullSuspended,
} from '@/features/playback/store/queuePlaybackIdle';
import { clearQueueHandoffPending, isQueueHandoffPending } from '@/features/playback/store/queueSyncUiState';
import { showToast } from '@/lib/dom/toast';

export function usePlayQueueSyncLedState(status: ConnectionStatus) {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const orbitRole = useOrbitStore(s => s.role);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const [pullInFlight, setPullInFlight] = useState(false);
  const idlePullSuspended = useSyncExternalStore(
    subscribeIdleQueuePullSuspended,
    getIdleQueuePullSuspendedSnapshot,
  );

  const queueItems = usePlayerStore(s => s.queueItems);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const currentTrackId = usePlayerStore(s => s.currentTrack?.id);

  const playbackServerId = useMemo(
    () => getPlaybackServerId(),
    // getPlaybackServerId() reads global queue/auth state; the listed values
    // are intentional recompute triggers, not direct inputs to the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeServerId, queueItems, queueIndex, currentTrackId],
  );

  useEffect(() => {
    if (activeServerId && playbackServerId && activeServerId === playbackServerId) {
      clearQueueHandoffPending();
    }
  }, [activeServerId, playbackServerId]);

  const autoSyncContext = canAutoIdlePlayQueuePull(status, orbitRole);
  const localQueueSyncPaused = autoSyncContext && idlePullSuspended && !isPlaying;

  const needsQueuePull = status === 'connected'
    && Boolean(activeServerId)
    && (
      (Boolean(playbackServerId) && activeServerId !== playbackServerId)
      || isQueueHandoffPending()
      || localQueueSyncPaused
    );

  const queueHandoffReason = status === 'connected'
    && Boolean(activeServerId)
    && Boolean(playbackServerId)
    && activeServerId !== playbackServerId;

  const ledVariant = status === 'checking'
    ? 'checking'
    : status === 'disconnected'
      ? 'disconnected'
      : needsQueuePull
        ? 'queue-handoff'
        : 'connected';

  const pullFromActiveServer = useCallback(async () => {
    if (status !== 'connected' || pullInFlight) return;
    if (orbitRole === 'host' || orbitRole === 'guest') return;
    if (currentRadio) return;

    setPullInFlight(true);
    try {
      const result = await pullPlayQueueFromActiveServer();
      switch (result) {
        case 'noop':
          showToast(t('connection.queueSynced'), 2500, 'info');
          break;
        case 'empty':
          showToast(t('connection.queuePullEmpty'), 4000, 'info');
          break;
        case 'applied':
          showToast(t('connection.queuePullSuccess'), 3000, 'info');
          break;
        case 'error':
          showToast(t('connection.queuePullFailed'), 5000, 'error');
          break;
        default:
          break;
      }
    } finally {
      setPullInFlight(false);
    }
  }, [currentRadio, orbitRole, pullInFlight, status, t]);

  const syncRingVisible = status === 'connected' && (needsQueuePull || pullInFlight);

  return {
    ledVariant,
    needsQueuePull,
    localQueueSyncPaused,
    queueHandoffReason,
    pullInFlight,
    syncRingVisible,
    pullFromActiveServer,
  };
}

export function canAutoIdlePlayQueuePull(
  status: ConnectionStatus,
  orbitRole: string | null,
): boolean {
  if (status !== 'connected') return false;
  if (orbitRole === 'host' || orbitRole === 'guest') return false;
  if (usePlayerStore.getState().currentRadio) return false;
  if (queueIsMultiServer()) return false;
  const activeId = useAuthStore.getState().activeServerId;
  const playbackId = getPlaybackServerId();
  if (!activeId || !playbackId || activeId !== playbackId) return false;
  return true;
}
