import { getPlayQueueForServer, type PlayQueueResult } from '@/lib/api/subsonicPlayQueue';
import { songToTrack } from '@/lib/media/songToTrack';
import { bindQueueServerId, queueIsMultiServer } from '@/features/playback/utils/playback/playbackServer';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import {
  canonicalizePlaybackTrack,
  toQueueItemRefs,
} from '@/features/playback/store/queueItemRef';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { profileIdFromQueueRef } from '@/lib/media/trackServerScope';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { preparePausedRestoreOnStartup } from '@/features/playback/store/pausedRestorePrepare';
import { isActivePublicShareQueue } from '@/lib/share/navidromePublicSharePlayback';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import { analysisTrackRef } from '@/features/playback/store/analysisTrackRef';
import {
  getIdlePullGeneration,
  isIdleQueuePullSuspended,
  isQueuePushFailed,
  clearQueuePushFailed,
  resumeIdleQueuePull,
  clearQueueNaturallyEnded,
} from '@/features/playback/store/queuePlaybackIdle';
import { clearQueueHandoffPending } from '@/features/playback/store/queueSyncUiState';
import { sameQueueTrack } from '@/features/playback/utils/playback/queueIdentity';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

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

function fingerprintFromLocalQueueForServer(serverProfileId: string): PlayQueueFingerprint {
  const state = usePlayerStore.getState();
  const refs = state.queueItems.filter(ref => profileIdFromQueueRef(ref) === serverProfileId);
  const currentRef = state.queueItems[state.queueIndex];
  const ownsCurrentTrack = profileIdFromQueueRef(currentRef) === serverProfileId;
  return {
    trackIds: refs.map(ref => ref.trackId),
    currentId: ownsCurrentTrack ? currentRef?.trackId ?? null : refs[0]?.trackId ?? null,
    positionMs: ownsCurrentTrack ? Math.floor((state.currentTime ?? 0) * 1000) : 0,
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

export function applyMappedQueue(
  mappedTracks: Track[],
  q: PlayQueueResult,
  serverProfileId: string,
  preferServerPosition: boolean,
  localTimeFallback: number,
): void {
  mappedTracks = mappedTracks.map(track => canonicalizePlaybackTrack(track, serverProfileId));
  let currentTrack = mappedTracks[0];
  let queueIndex = 0;

  if (q.current) {
    const currentId = canonicalizeConfirmedNavidromeId(serverProfileId, q.current);
    const idx = mappedTracks.findIndex(t => t.id === currentId);
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
  const sameCurrent = sameQueueTrack(player.currentTrack, currentTrack);

  usePlayerStore.setState({
    queueItems,
    queueIndex,
    currentTrack,
    currentTime: atSeconds,
  });
  void refreshWaveformForTrack(analysisTrackRef(currentTrack.id, serverProfileId));

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

export function mergeQueueServerProjection(
  existing: QueueItemRef[],
  serverProfileId: string,
  remote: QueueItemRef[],
  preserveLocalSurplus = true,
): QueueItemRef[] {
  const merged: QueueItemRef[] = [];
  let remoteIndex = 0;
  let insertionIndex = existing.length;
  let hadPriorSlot = false;

  for (const ref of existing) {
    if (profileIdFromQueueRef(ref) !== serverProfileId) {
      merged.push(ref);
      continue;
    }

    hadPriorSlot = true;
    if (remoteIndex < remote.length) {
      merged.push(remote[remoteIndex]);
      remoteIndex++;
    } else if (preserveLocalSurplus) {
      merged.push(ref);
    }
    insertionIndex = merged.length;
  }

  if (!hadPriorSlot) insertionIndex = merged.length;
  if (remoteIndex < remote.length) {
    merged.splice(insertionIndex, 0, ...remote.slice(remoteIndex));
  }
  return merged;
}

export function applyMappedQueueProjection(
  mappedTracks: Track[],
  q: PlayQueueResult,
  serverProfileId: string,
  preserveLocalSurplus = true,
): void {
  mappedTracks = mappedTracks.map(track => canonicalizePlaybackTrack(track, serverProfileId));
  seedQueueResolver(serverProfileId, mappedTracks);
  const remoteRefs = toQueueItemRefs(serverProfileId, mappedTracks);
  const player = usePlayerStore.getState();
  const previousCurrentRef = player.queueItems[player.queueIndex];
  const queueItems = mergeQueueServerProjection(
    player.queueItems,
    serverProfileId,
    remoteRefs,
    preserveLocalSurplus,
  );

  const exactPreservedIndex = previousCurrentRef ? queueItems.indexOf(previousCurrentRef) : -1;
  const preservedIndex = exactPreservedIndex >= 0
    ? exactPreservedIndex
    : previousCurrentRef
      ? queueItems.findIndex(ref => (
        profileIdFromQueueRef(ref) === profileIdFromQueueRef(previousCurrentRef)
        && ref.trackId === previousCurrentRef.trackId
      ))
      : -1;

  if (preservedIndex >= 0) {
    usePlayerStore.setState({ queueItems, queueIndex: preservedIndex });
    return;
  }

  const currentId = q.current
    ? canonicalizeConfirmedNavidromeId(serverProfileId, q.current)
    : mappedTracks[0]?.id;
  const remoteIndex = mappedTracks.findIndex(track => track.id === currentId);
  const currentTrack = mappedTracks[remoteIndex >= 0 ? remoteIndex : 0];
  if (!currentTrack) {
    usePlayerStore.setState({ queueItems, queueIndex: Math.min(player.queueIndex, Math.max(0, queueItems.length - 1)) });
    return;
  }

  const queueIndex = queueItems.findIndex(ref => (
    profileIdFromQueueRef(ref) === serverProfileId && ref.trackId === currentTrack.id
  ));
  const atSeconds = q.position ? q.position / 1000 : 0;
  usePlayerStore.setState({
    queueItems,
    queueIndex: queueIndex >= 0 ? queueIndex : 0,
    currentTrack,
    currentTime: atSeconds,
  });
  void refreshWaveformForTrack(analysisTrackRef(currentTrack.id, serverProfileId));
  if (!player.isPlaying) {
    preparePausedRestoreOnStartup(currentTrack, queueItems, queueIndex >= 0 ? queueIndex : 0, atSeconds);
  }
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

  const local = usePlayerStore.getState();
  if (options.mode !== 'startup' && isActivePublicShareQueue(local.queueServerId, local.queueItems)) {
    return 'noop';
  }

  if (options.mode === 'idle' && (isIdleQueuePullSuspended() || isQueuePushFailed(profileId))) {
    return 'noop';
  }
  const idleGenerationAtStart = options.mode === 'idle' ? getIdlePullGeneration() : null;

  try {
    const q = await getPlayQueueForServer(profileId);
    if (q.songs.length === 0) return 'empty';

    const localAfterFetch = usePlayerStore.getState();
    if (
      options.mode !== 'startup'
      && isActivePublicShareQueue(localAfterFetch.queueServerId, localAfterFetch.queueItems)
    ) {
      return 'noop';
    }

    const preferServerPosition = options.preferServerPosition ?? options.mode !== 'startup';
    if (options.mode === 'idle') {
      if (isIdleQueuePullSuspended() || isQueuePushFailed(profileId)) return 'noop';
      if (idleGenerationAtStart !== getIdlePullGeneration()) return 'noop';
      const serverFp = fingerprintFromServer(q);
      const localFp = queueIsMultiServer()
        ? fingerprintFromLocalQueueForServer(profileId)
        : fingerprintFromLocalQueue();
      if (playQueueFingerprintsEqual(serverFp, localFp)) return 'noop';
    }

    if (options.pushUndo) {
      pushQueueUndoFromGetter(usePlayerStore.getState);
    }

    const mappedTracks: Track[] = q.songs.map(song => ({ ...songToTrack(song), serverId: profileId }));
    const localTime = usePlayerStore.getState().currentTime;
    if (queueIsMultiServer()) {
      // Keep the other owners' slots in place while refreshing this server's order.
      // Background pulls preserve local surplus; an explicit manual pull has an
      // undo snapshot and may intentionally accept the shorter remote queue.
      applyMappedQueueProjection(mappedTracks, q, profileId, !options.pushUndo);
    } else {
      applyMappedQueue(mappedTracks, q, profileId, preferServerPosition, localTime);
    }
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

export async function pullPlayQueueFromServer(serverId: string): Promise<ApplyPlayQueueResult> {
  if (!serverId) return 'error';

  clearQueueNaturallyEnded();

  try {
    const q = await getPlayQueueForServer(serverId);
    if (q.songs.length === 0) {
      resumeIdleQueuePull();
      clearQueuePushFailed(serverId);
      return 'empty';
    }

    const serverFp = fingerprintFromServer(q);
    const localFp = queueIsMultiServer()
      ? fingerprintFromLocalQueueForServer(serverId)
      : fingerprintFromLocalQueue();
    if (playQueueFingerprintsEqual(serverFp, localFp)) {
      resumeIdleQueuePull();
      clearQueuePushFailed(serverId);
      return 'noop';
    }

    const result = await applyServerPlayQueue(serverId, {
      mode: 'manual',
      preferServerPosition: true,
      pushUndo: true,
    });
    if (result === 'applied' || result === 'noop') {
      resumeIdleQueuePull();
      clearQueuePushFailed(serverId);
    }
    return result;
  } catch (e) {
    console.error('[psysonic] pullPlayQueueFromServer failed', e);
    return 'error';
  }
}

/** @deprecated Resolve the queue owner and call {@link pullPlayQueueFromServer}. */
export async function pullPlayQueueFromActiveServer(): Promise<ApplyPlayQueueResult> {
  const activeId = useAuthStore.getState().activeServerId;
  return activeId ? pullPlayQueueFromServer(activeId) : 'error';
}
