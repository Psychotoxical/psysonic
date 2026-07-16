/**
 * HTTP-stream playback often starts from a thin-queue placeholder (or any track
 * snapshot missing ReplayGain tags). `audio_play` then applies fallback gain.
 * The queue resolver fetches full metadata asynchronously — this side-effect
 * upgrades `currentTrack` and pushes fresh gain to the engine once tags land,
 * mirroring the loudness cache refresh path (`refreshLoudnessForTrack`).
 *
 * After library sync, {@link maybeRefreshCurrentTrackMetadataFromIndex} re-reads
 * index-first metadata for the live slot so recalculated ReplayGain tags apply
 * without re-starting playback.
 */
import { listen } from '@tauri-apps/api/event';
import type { LibrarySyncIdlePayload } from '@/lib/api/library/dto';
import { resolveSongMetaIndexFirst } from '@/lib/library/resolveSongMetaIndexFirst';
import { mergePlaybackTrackMetadata } from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';
import { resolveReplayGainDb } from '@/features/playback/utils/audio/resolveReplayGainDb';
import { isReplayGainActive } from '@/features/playback/store/loudnessGainCache';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  patchCachedTrack,
  subscribeQueueResolver,
} from '@/features/playback/store/queueTrackResolver';
import { playbackCacheKeyForRef } from '@/features/playback/utils/playback/playbackServer';
import { songToTrack } from '@/lib/media/songToTrack';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import { useAuthStore } from '@/store/authStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';

function replayGainNeighbours(
  queueItems: QueueItemRef[],
  queueIndex: number,
): { prev: Track | null; next: Track | null } {
  const prev = queueIndex > 0 && queueItems[queueIndex - 1]
    ? resolveQueueTrack(queueItems[queueIndex - 1])
    : null;
  const next = queueIndex + 1 < queueItems.length && queueItems[queueIndex + 1]
    ? resolveQueueTrack(queueItems[queueIndex + 1])
    : null;
  return { prev, next };
}

function resolvedReplayGainDb(
  track: Track,
  queueItems: QueueItemRef[],
  queueIndex: number,
): number | null {
  const auth = useAuthStore.getState();
  const { prev, next } = replayGainNeighbours(queueItems, queueIndex);
  return resolveReplayGainDb(track, prev, next, true, auth.replayGainMode);
}

/** True when resolver metadata would change the ReplayGain bind for this slot. */
export function shouldUpgradeReplayGainMetadata(
  prev: Track,
  next: Track,
  queueItems: QueueItemRef[],
  queueIndex: number,
): boolean {
  if (prev.replayGainPeak !== next.replayGainPeak) return true;
  return resolvedReplayGainDb(prev, queueItems, queueIndex)
    !== resolvedReplayGainDb(next, queueItems, queueIndex);
}

/** True when resolver metadata would improve the live player-bar snapshot. */
export function shouldSyncCurrentTrackMetadata(
  prev: Track,
  next: Track,
  queueItems: QueueItemRef[],
  queueIndex: number,
): boolean {
  if (prev.title === '…' && next.title && next.title !== '…') return true;
  if (prev.duration === 0 && next.duration > 0) return true;
  return shouldUpgradeReplayGainMetadata(prev, next, queueItems, queueIndex);
}

function applyCurrentTrackMetadataUpgrade(
  prev: Track,
  merged: Track,
  queueItems: QueueItemRef[],
  queueIndex: number,
): void {
  if (!shouldSyncCurrentTrackMetadata(prev, merged, queueItems, queueIndex)) return;

  usePlayerStore.setState({ currentTrack: merged });
  patchCachedTrack(prev.serverId ?? usePlayerStore.getState().queueServerId ?? '', prev.id, {
    title: merged.title,
    duration: merged.duration,
    replayGainTrackDb: merged.replayGainTrackDb,
    replayGainAlbumDb: merged.replayGainAlbumDb,
    replayGainPeak: merged.replayGainPeak,
  });
  if (
    isReplayGainActive()
    && shouldUpgradeReplayGainMetadata(prev, merged, queueItems, queueIndex)
  ) {
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
  }
}

/** True when a library sync-idle event applies to this queue ref's server. */
export function syncIdleAppliesToQueueRef(syncServerId: string, ref: QueueItemRef): boolean {
  const scopeId = syncServerId.trim();
  if (!scopeId) return false;
  const profileId = resolveServerIdForIndexKey(scopeId) || scopeId;
  const refCanonical = canonicalQueueServerKey(ref.serverId);
  const refProfile = resolveServerIdForIndexKey(ref.serverId) || ref.serverId;
  return ref.serverId === scopeId
    || ref.serverId === profileId
    || refCanonical === scopeId
    || refCanonical === profileId
    || refProfile === scopeId
    || refProfile === profileId;
}

/** Push resolver-fetched metadata onto the live track; upgrade engine gain when needed. */
export function maybeSyncCurrentTrackFromResolver(): void {
  const state = usePlayerStore.getState();
  const { currentTrack, queueItems, queueIndex, isPlaying, currentRadio } = state;
  if (!currentTrack || !isPlaying || currentRadio) return;
  const ref = queueItems[queueIndex];
  if (!ref || ref.trackId !== currentTrack.id) return;

  const resolved = resolveQueueTrack(ref, currentTrack);
  const merged = mergePlaybackTrackMetadata(currentTrack, resolved);
  applyCurrentTrackMetadataUpgrade(currentTrack, merged, queueItems, queueIndex);
}

/**
 * Re-read index-first metadata for the playing slot and upgrade ReplayGain when
 * library tags differ from the live snapshot (post-sync recalc, new tags, peak).
 */
export async function maybeRefreshCurrentTrackMetadataFromIndex(): Promise<void> {
  const state = usePlayerStore.getState();
  const { currentTrack, queueItems, queueIndex, isPlaying, currentRadio } = state;
  if (!currentTrack || !isPlaying || currentRadio) return;
  const ref = queueItems[queueIndex];
  if (!ref || ref.trackId !== currentTrack.id) return;

  const serverId = playbackCacheKeyForRef(ref);
  if (!serverId) return;

  const trackId = currentTrack.id;
  const song = await resolveSongMetaIndexFirst(serverId, trackId);
  if (!song) return;

  const live = usePlayerStore.getState();
  if (!live.isPlaying || live.currentRadio || !live.currentTrack) return;
  const liveRef = live.queueItems[live.queueIndex];
  if (live.currentTrack.id !== trackId || liveRef?.trackId !== trackId) return;

  const merged = mergePlaybackTrackMetadata(live.currentTrack, songToTrack(song));
  applyCurrentTrackMetadataUpgrade(live.currentTrack, merged, live.queueItems, live.queueIndex);
}

let indexRefreshInflight: Promise<void> | null = null;

export function scheduleCurrentTrackMetadataRefreshFromIndex(): void {
  if (indexRefreshInflight) return;
  indexRefreshInflight = maybeRefreshCurrentTrackMetadataFromIndex()
    .catch(() => {})
    .finally(() => {
      indexRefreshInflight = null;
    });
}

/** Test-only: drop coalesced index refresh state. */
export function _resetIndexRefreshInflightForTest(): void {
  indexRefreshInflight = null;
}

function scheduleIndexRefreshAfterSyncIdle(payload: LibrarySyncIdlePayload): void {
  if (!payload.ok) return;
  const state = usePlayerStore.getState();
  if (!state.isPlaying || state.currentRadio || !state.currentTrack) return;
  const ref = state.queueItems[state.queueIndex];
  if (!ref || ref.trackId !== state.currentTrack.id) return;
  if (!syncIdleAppliesToQueueRef(payload.serverId, ref)) return;
  scheduleCurrentTrackMetadataRefreshFromIndex();
}

subscribeQueueResolver(() => {
  maybeSyncCurrentTrackFromResolver();
});

void listen<LibrarySyncIdlePayload>('library:sync-idle', ({ payload }) => {
  scheduleIndexRefreshAfterSyncIdle(payload);
});
