import { getPlayQueueForServer, type PlayQueueResult } from '@/lib/api/subsonicPlayQueue';
import { songToTrack } from '@/lib/media/songToTrack';
import { bindQueueServerId } from '@/features/playback/utils/playback/playbackServer';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import type { Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { preparePausedRestoreOnStartup } from '@/features/playback/store/pausedRestorePrepare';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import {
  getIdlePullGeneration,
  isIdleQueuePullSuspended,
  resumeIdleQueuePull,
  clearQueueNaturallyEnded,
} from '@/features/playback/store/queuePlaybackIdle';
import { clearQueueHandoffPending } from '@/features/playback/store/queueSyncUiState';

export type ApplyPlayQueueMode = 'startup' | 'idle' | 'manual';

export type PlayQueueFingerprint = {
  trackIds: string[];
  currentId: string | null;
  positionMs: number;
};

export type ApplyPlayQueueResult = 'applied' | 'noop' | 'empty' | 'error';

const POSITION_TOLERANCE_MS = 2000;

export function fingerprintFromServer(q: PlayQueueResult): PlayQueueFingerprint {
  const trackIds = q.songs.map(s => s.id);
  const currentId = q.current ?? trackIds[0] ?? null;
  return {
    trackIds,
    currentId,
    positionMs: q.position ?? 0,
  };
}

export function fingerprintFromLocalQueue(): PlayQueueFingerprint {
  const s = usePlayerStore.getState();
  return {
    trackIds: s.queueItems.map(r => r.trackId),
    currentId: s.currentTrack?.id ?? null,
    positionMs: Math.floor((s.currentTime ?? 0) * 1000),
  };
}

export function playQueueFingerprintsEqual(
  a: PlayQueueFingerprint,
  b: PlayQueueFingerprint,
  positionToleranceMs = POSITION_TOLERANCE_MS,
): boolean {
  if (a.currentId !== b.currentId) return false;
  if (a.trackIds.length !== b.trackIds.length) return false;
  for (let i = 0; i < a.trackIds.length; i++) {
    if (a.trackIds[i] !== b.trackIds[i]) return false;
  }
  return Math.abs(a.positionMs - b.positionMs) <= positionToleranceMs;
}

function resolveServerProfileId(serverId: string): string {
  return resolveServerIdForIndexKey(serverId) || serverId;
}

function applyMappedQueue(
  mappedTracks: Track[],
  q: PlayQueueResult,
  serverProfileId: string,
  preferServerPosition: boolean,
  localTimeFallback: number,
): void {
  let currentTrack = mappedTracks[0];
  let queueIndex = 0;

  if (q.current) {
    const idx = mappedTracks.findIndex(t => t.id === q.current);
    if (idx >= 0) {
      currentTrack = mappedTracks[idx];
      queueIndex = idx;
    }
  }

  const serverTime = q.position ? q.position / 1000 : 0;
  const atSeconds = preferServerPosition
    ? serverTime
    : (serverTime > 0 ? serverTime : localTimeFallback);

  seedQueueResolver(serverProfileId, mappedTracks);
  bindQueueServerId(serverProfileId);
  const queueItems = toQueueItemRefs(serverProfileId, mappedTracks);

  const player = usePlayerStore.getState();
  const wasPlaying = player.isPlaying;
  const sameCurrent = player.currentTrack?.id === currentTrack.id;

  usePlayerStore.setState({
    queueItems,
    queueIndex,
    currentTrack,
    currentTime: atSeconds,
  });
  void refreshWaveformForTrack(currentTrack.id);

  if (wasPlaying) {
    if (!sameCurrent) {
      player.playTrack(currentTrack, mappedTracks, true, false, queueIndex);
      if (atSeconds > 0.05) {
        player.seek(atSeconds / Math.max(currentTrack.duration, 1));
      }
    } else if (atSeconds > 0.05 && Math.abs(player.currentTime - atSeconds) > 0.5) {
      player.seek(atSeconds / Math.max(currentTrack.duration, 1));
    }
    return;
  }

  preparePausedRestoreOnStartup(currentTrack, queueItems, queueIndex, atSeconds);
}

export async function applyServerPlayQueue(
  serverId: string,
  options: {
    mode: ApplyPlayQueueMode;
    preferServerPosition?: boolean;
    pushUndo?: boolean;
  },
): Promise<ApplyPlayQueueResult> {
  const profileId = resolveServerProfileId(serverId);
  if (!profileId) return 'error';

  if (options.mode === 'idle' && isIdleQueuePullSuspended()) {
    return 'noop';
  }
  const idleGenerationAtStart = options.mode === 'idle' ? getIdlePullGeneration() : null;

  try {
    const q = await getPlayQueueForServer(profileId);
    if (q.songs.length === 0) return 'empty';

    const preferServerPosition = options.preferServerPosition ?? options.mode !== 'startup';
    if (options.mode === 'idle') {
      if (isIdleQueuePullSuspended()) return 'noop';
      if (idleGenerationAtStart !== getIdlePullGeneration()) return 'noop';
      const serverFp = fingerprintFromServer(q);
      const localFp = fingerprintFromLocalQueue();
      if (playQueueFingerprintsEqual(serverFp, localFp)) return 'noop';
    }

    if (options.pushUndo) {
      pushQueueUndoFromGetter(usePlayerStore.getState);
    }

    const mappedTracks: Track[] = q.songs.map(songToTrack);
    const localTime = usePlayerStore.getState().currentTime;
    applyMappedQueue(mappedTracks, q, profileId, preferServerPosition, localTime);
    clearQueueHandoffPending();
    return 'applied';
  } catch (e) {
    console.error('[psysonic] applyServerPlayQueue failed', e);
    return 'error';
  }
}

export async function fetchActiveServerPlayQueueFingerprint(): Promise<PlayQueueFingerprint | null> {
  const activeId = useAuthStore.getState().activeServerId;
  if (!activeId) return null;
  try {
    const q = await getPlayQueueForServer(activeId);
    if (q.songs.length === 0) return null;
    return fingerprintFromServer(q);
  } catch {
    return null;
  }
}

export async function pullPlayQueueFromActiveServer(): Promise<ApplyPlayQueueResult> {
  const activeId = useAuthStore.getState().activeServerId;
  if (!activeId) return 'error';

  clearQueueNaturallyEnded();

  try {
    const q = await getPlayQueueForServer(activeId);
    if (q.songs.length === 0) {
      resumeIdleQueuePull();
      return 'empty';
    }

    const serverFp = fingerprintFromServer(q);
    const localFp = fingerprintFromLocalQueue();
    if (playQueueFingerprintsEqual(serverFp, localFp)) {
      resumeIdleQueuePull();
      return 'noop';
    }

    const result = await applyServerPlayQueue(activeId, {
      mode: 'manual',
      preferServerPosition: true,
      pushUndo: true,
    });
    if (result === 'applied' || result === 'noop') {
      resumeIdleQueuePull();
    }
    return result;
  } catch (e) {
    console.error('[psysonic] pullPlayQueueFromActiveServer failed', e);
    return 'error';
  }
}
