import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { invoke } from '@tauri-apps/api/core';
import { audioPlayHiResBlendArgs } from '@/lib/audio/hiResCrossfadeResample';
import { prepareTrackForEngineBind } from '@/features/playback/utils/audio/prepareTrackForEngineBind';
import { resolveReplayGainDb } from '@/features/playback/utils/audio/resolveReplayGainDb';
import {
  getPlaybackCacheServerKey,
  getPlaybackIndexKey,
  playbackCacheKeyForRef,
} from '@/features/playback/utils/playback/playbackServer';
import { resolvePlaybackUrlForTrack } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  getGaplessPreloadingId,
  setGaplessPreloadingId,
} from '@/features/playback/store/gaplessPreloadState';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from '@/features/playback/store/loudnessGainCache';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';

export type GaplessChainPreloadContext = {
  currentTrack: Track;
  nextTrack: Track;
  nextRef: QueueItemRef | null;
  nextIdx: number;
  queueItems: QueueItemRef[];
  repeatMode: 'off' | 'one' | 'all';
  volume: number;
};

const gaplessChainPrepareInflight = new Map<string, Promise<void>>();

function gaplessNextNeighbour(
  ctx: GaplessChainPreloadContext,
): Track | null {
  const { nextIdx, queueItems, repeatMode } = ctx;
  const nextNeighbourRef = nextIdx + 1 < queueItems.length
    ? queueItems[nextIdx + 1]
    : (repeatMode === 'all' && queueItems.length > 0 ? queueItems[0] : null);
  return nextNeighbourRef ? resolveQueueTrack(nextNeighbourRef) : null;
}

function invokeGaplessChainPreload(
  prepared: Track,
  ctx: GaplessChainPreloadContext,
): void {
  const authState = useAuthStore.getState();
  const serverId = ctx.nextRef ? playbackCacheKeyForRef(ctx.nextRef) : getPlaybackCacheServerKey();
  const analysisServerId = ctx.nextRef
    ? playbackCacheKeyForRef(ctx.nextRef)
    : getPlaybackIndexKey();
  const nextUrl = resolvePlaybackUrlForTrack(prepared, serverId);
  const nextNeighbour = gaplessNextNeighbour(ctx);
  const replayGainDb = resolveReplayGainDb(
    prepared, ctx.currentTrack, nextNeighbour,
    isReplayGainActive(), authState.replayGainMode,
  );
  const replayGainPeak = isReplayGainActive()
    ? (prepared.replayGainPeak ?? null)
    : null;
  invoke('audio_chain_preload', {
    url: nextUrl,
    volume: ctx.volume,
    durationHint: prepared.duration,
    replayGainDb,
    replayGainPeak,
    loudnessGainDb: loudnessGainDbForEngineBind(prepared.id),
    preGainDb: authState.replayGainPreGainDb,
    fallbackDb: authState.replayGainFallbackDb,
    ...audioPlayHiResBlendArgs(authState),
    analysisTrackId: prepared.id,
    serverId: analysisServerId || null,
  }).catch(() => {});
}

function liveNextRefForContext(
  queueItems: QueueItemRef[],
  queueIndex: number,
  repeatMode: 'off' | 'one' | 'all',
): QueueItemRef | null {
  if (repeatMode === 'one') return null;
  const nextIdx = queueIndex + 1;
  if (nextIdx < queueItems.length) return queueItems[nextIdx] ?? null;
  if (repeatMode === 'all' && queueItems.length > 0) return queueItems[0] ?? null;
  return null;
}

/**
 * Prefetch metadata + loudness, then hand the next track to `audio_chain_preload`.
 * Coalesces concurrent prepares for the same id; retries on the next progress
 * tick when validation fails (track skip, queue rewrite).
 */
export function requestGaplessChainPreload(ctx: GaplessChainPreloadContext): void {
  const { nextTrack } = ctx;
  if (getGaplessPreloadingId() === nextTrack.id) return;
  if (gaplessChainPrepareInflight.has(nextTrack.id)) return;

  const job = (async () => {
    try {
      const serverId = ctx.nextRef
        ? playbackCacheKeyForRef(ctx.nextRef)
        : getPlaybackCacheServerKey();
      const prepared = serverId
        ? await prepareTrackForEngineBind(nextTrack, serverId)
        : nextTrack;
      if (serverId) {
        await refreshLoudnessForTrack(prepared.id, { syncPlayingEngine: false });
      }

      const store = usePlayerStore.getState();
      if (!store.isPlaying || store.currentRadio) return;
      if (store.currentTrack?.id !== ctx.currentTrack.id) return;

      const liveNextRef = liveNextRefForContext(
        store.queueItems,
        store.queueIndex,
        store.repeatMode,
      );
      if (liveNextRef?.trackId !== prepared.id) return;
      if (getGaplessPreloadingId() === prepared.id) return;

      setGaplessPreloadingId(prepared.id);
      invokeGaplessChainPreload(prepared, {
        ...ctx,
        currentTrack: store.currentTrack ?? ctx.currentTrack,
        nextTrack: prepared,
        nextRef: liveNextRef,
      });
    } finally {
      gaplessChainPrepareInflight.delete(nextTrack.id);
    }
  })().catch(() => {});
  gaplessChainPrepareInflight.set(nextTrack.id, job);
}

/** Test-only: drop pending gapless chain prepare promises. */
export function _resetGaplessChainPrepareInflightForTest(): void {
  gaplessChainPrepareInflight.clear();
}
