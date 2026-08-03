// Engine-side registration for the playback-engine bridge. Side-effect module:
// importing it installs the engine's operations into @/store/playbackEngineBridge.
// MainApp side-effect-imports this at boot. Lives with the engine (moves into
// @/features/playback alongside playerStore); the bridge itself stays in core.
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { clearPreloadingIds } from '@/features/playback/store/gaplessPreloadState';
import { clearQueueServerForPlayback } from '@/features/playback/utils/playback/playbackServer';
import { audioInvalidatePreloads } from '@/lib/api/audio';
import { subscribeConnectCache } from '@/lib/server/serverEndpoint';
import { registerPlaybackEngineBridge } from '@/store/playbackEngineBridge';

// Keep invalidations ordered. A second URL-affecting change that lands while
// the first native command is in flight must bump the epoch again afterwards.
let preloadInvalidationTail: Promise<void> = Promise.resolve();

export function invalidateNativePreloads(): Promise<void> {
  const run = preloadInvalidationTail
    .catch(() => {})
    .then(async () => {
      await audioInvalidatePreloads();
      clearPreloadingIds();
      usePlayerStore.setState({ enginePreloadedTrackId: null });
    });
  preloadInvalidationTail = run;
  return run;
}

registerPlaybackEngineBridge({
  getQueueServerId: () => usePlayerStore.getState().queueServerId,
  clearQueueServerForPlayback,
  updateReplayGainForCurrentTrack: () => usePlayerStore.getState().updateReplayGainForCurrentTrack(),
  invalidatePreloads: invalidateNativePreloads,
});

subscribeConnectCache(() => {
  void invalidateNativePreloads().catch(() => {});
});
