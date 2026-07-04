/**
 * HTTP-stream playback often starts from a thin-queue placeholder (or any track
 * snapshot missing ReplayGain tags). `audio_play` then applies fallback gain.
 * The queue resolver fetches full metadata asynchronously — this side-effect
 * upgrades `currentTrack` and pushes fresh gain to the engine once tags land,
 * mirroring the loudness cache refresh path (`refreshLoudnessForTrack`).
 */
import { mergePlaybackTrackMetadata } from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';
import { resolveReplayGainDb } from '@/features/playback/utils/audio/resolveReplayGainDb';
import { isReplayGainActive } from '@/features/playback/store/loudnessGainCache';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { subscribeQueueResolver } from '@/features/playback/store/queueTrackResolver';
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

/** Push resolver-fetched metadata onto the live track; upgrade engine gain when needed. */
export function maybeSyncCurrentTrackFromResolver(): void {
  const state = usePlayerStore.getState();
  const { currentTrack, queueItems, queueIndex, isPlaying, currentRadio } = state;
  if (!currentTrack || !isPlaying || currentRadio) return;
  const ref = queueItems[queueIndex];
  if (!ref || ref.trackId !== currentTrack.id) return;

  const resolved = resolveQueueTrack(ref, currentTrack);
  const merged = mergePlaybackTrackMetadata(currentTrack, resolved);
  if (!shouldSyncCurrentTrackMetadata(currentTrack, merged, queueItems, queueIndex)) return;

  usePlayerStore.setState({ currentTrack: merged });
  if (
    isReplayGainActive()
    && shouldUpgradeReplayGainMetadata(currentTrack, merged, queueItems, queueIndex)
  ) {
    usePlayerStore.getState().updateReplayGainForCurrentTrack();
  }
}

/** @deprecated alias — use {@link maybeSyncCurrentTrackFromResolver} */
export const maybeSyncReplayGainFromResolver = maybeSyncCurrentTrackFromResolver;

subscribeQueueResolver(() => {
  maybeSyncCurrentTrackFromResolver();
});
