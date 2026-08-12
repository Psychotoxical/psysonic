import { fetchPlayQueueForServer, type PlayQueueResult } from '@/lib/api/subsonicPlayQueue';
import { songToTrack } from '@/lib/media/songToTrack';
import { profileIdFromQueueRef } from '@/lib/media/trackServerScope';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import {
  applyMappedQueue,
  applyMappedQueueProjection,
} from '@/features/playback/store/applyServerPlayQueue';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { filterQueueRefsForServerProfile } from '@/features/playback/utils/playback/trackServerScope';
import { sameQueueTrack } from '@/features/playback/utils/playback/queueIdentity';

type StructuralQueue = {
  trackIds: string[];
  currentId: string | null;
};

type LocalQueueSnapshot = {
  queueItems: QueueItemRef[];
  queueIndex: number;
  currentTrack: Track | null;
  isPlaying: boolean;
  currentRadioId: string | null;
};

export type StartupQueueReconcileResult = 'applied' | 'kept-local';

type StartupQueueReconcileOptions = {
  shouldAbort?: () => boolean;
};

function structuralQueueEqual(a: StructuralQueue, b: StructuralQueue): boolean {
  if (a.currentId !== b.currentId || a.trackIds.length !== b.trackIds.length) return false;
  return a.trackIds.every((id, index) => id === b.trackIds[index]);
}

function localProjection(snapshot: LocalQueueSnapshot, serverId: string): StructuralQueue {
  const refs = filterQueueRefsForServerProfile(snapshot.queueItems, serverId);
  const currentRef = snapshot.queueItems[snapshot.queueIndex];
  const currentOwnedByServer = currentRef && profileIdFromQueueRef(currentRef) === serverId;
  return {
    trackIds: refs.map(ref => ref.trackId),
    currentId: currentOwnedByServer ? currentRef.trackId : refs[0]?.trackId ?? null,
  };
}

function remoteProjection(queue: PlayQueueResult): StructuralQueue | null {
  const trackIds = queue.songs.map(song => song.id).filter(Boolean);
  if (trackIds.length !== queue.songs.length) return null;
  if (trackIds.length === 0) return { trackIds, currentId: null };
  const currentId = queue.current ?? trackIds[0] ?? null;
  if (!currentId || !trackIds.includes(currentId)) return null;
  return { trackIds, currentId };
}

function takeLocalSnapshot(): LocalQueueSnapshot {
  const state = usePlayerStore.getState();
  return {
    queueItems: state.queueItems.map(ref => ({ ...ref })),
    queueIndex: state.queueIndex,
    currentTrack: state.currentTrack ? { ...state.currentTrack } : null,
    isPlaying: state.isPlaying,
    currentRadioId: state.currentRadio?.id ?? null,
  };
}

function localSnapshotStillCurrent(snapshot: LocalQueueSnapshot): boolean {
  const state = usePlayerStore.getState();
  if (
    state.queueIndex !== snapshot.queueIndex
    || !(
      state.currentTrack == null && snapshot.currentTrack == null
      || sameQueueTrack(state.currentTrack, snapshot.currentTrack)
    )
    || state.isPlaying !== snapshot.isPlaying
    || (state.currentRadio?.id ?? null) !== snapshot.currentRadioId
    || state.queueItems.length !== snapshot.queueItems.length
  ) return false;
  return state.queueItems.every((ref, index) => {
    const before = snapshot.queueItems[index];
    return ref.serverId === before?.serverId && ref.trackId === before.trackId;
  });
}

function selectedServerScope(): string[] {
  return [...new Set(useAuthStore.getState().libraryBrowseServerIds.filter(Boolean))];
}

function sameServerScope(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((serverId, index) => serverId === b[index]);
}

/**
 * Preserve the persisted mixed queue unless exactly one selected server has a
 * structurally different, non-empty remote queue. Position is intentionally
 * ignored because local playback position is not persisted in the queue blob.
 */
export async function reconcileStartupPlayQueues(
  options: StartupQueueReconcileOptions = {},
): Promise<StartupQueueReconcileResult> {
  const selectedServerIds = selectedServerScope();
  if (selectedServerIds.length === 0) return 'kept-local';
  if (options.shouldAbort?.()) return 'kept-local';

  const snapshot = takeLocalSnapshot();
  if (snapshot.currentRadioId) return 'kept-local';

  const representedServerIds = new Set(snapshot.queueItems.map(profileIdFromQueueRef).filter(Boolean));
  if ([...representedServerIds].some(serverId => !selectedServerIds.includes(serverId))) {
    return 'kept-local';
  }

  const settled = await Promise.allSettled(selectedServerIds.map(async serverId => ({
    serverId,
    queue: await fetchPlayQueueForServer(serverId),
  })));
  if (options.shouldAbort?.()) return 'kept-local';
  if (!sameServerScope(selectedServerIds, selectedServerScope())) return 'kept-local';
  if (settled.some(result => result.status === 'rejected')) return 'kept-local';
  if (!localSnapshotStillCurrent(snapshot)) return 'kept-local';

  const changed: Array<{ serverId: string; queue: PlayQueueResult }> = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') return 'kept-local';
    if (result.value.queue.songs.length === 0) return 'kept-local';
    const remote = remoteProjection(result.value.queue);
    if (!remote) return 'kept-local';
    const local = localProjection(snapshot, result.value.serverId);
    if (!structuralQueueEqual(local, remote)) changed.push(result.value);
  }

  if (changed.length !== 1 || changed[0].queue.songs.length === 0) return 'kept-local';
  const [{ serverId, queue }] = changed;
  const mappedTracks = queue.songs.map(song => ({ ...songToTrack(song), serverId }));
  if (options.shouldAbort?.()) return 'kept-local';
  if (!sameServerScope(selectedServerIds, selectedServerScope())) return 'kept-local';
  if (!localSnapshotStillCurrent(snapshot)) return 'kept-local';
  if (representedServerIds.size > 1) {
    applyMappedQueueProjection(mappedTracks, queue, serverId);
  } else {
    applyMappedQueue(mappedTracks, queue, serverId, true, 0);
  }
  return 'applied';
}
