import type { Track } from '@/lib/media/trackTypes';
import {
  getPlaybackIndexKey,
  playbackCacheKeyForTrack,
} from '@/features/playback/utils/playback/playbackServer';
import { getPlayGeneration } from '@/features/playback/store/engineState';
import { engineLoadTrackAtPosition } from '@/features/playback/store/engineLoadTrackAtPosition';
import { prepareTrackForEngineBind } from '@/features/playback/utils/audio/prepareTrackForEngineBind';

/**
 * Reload the Rust audio engine to match a queue-undo snapshot. Zustand
 * alone can rewrite the queue + currentTrack, but the engine is still
 * playing whatever cold-started before the undo — so we need a full
 * `audio_play` (+ optional `audio_seek` to the snapshot position) to
 * line the audible playback back up with the restored UI state.
 *
 * Captures the play-generation at start so a later concurrent `playTrack`
 * (e.g. user clicks another track) invalidates the seek/pause follow-up
 * without clobbering the new engine state.
 */
export function queueUndoRestoreAudioEngine(opts: {
  generation: number;
  track: Track;
  queue: Track[];
  queueIndex: number;
  atSeconds: number;
  wantPlaying: boolean;
}): void {
  void (async () => {
    const serverId =
      playbackCacheKeyForTrack(opts.track)
      || getPlaybackIndexKey()
      || '';
    const track = serverId
      ? await prepareTrackForEngineBind(opts.track, serverId)
      : opts.track;
    if (getPlayGeneration() !== opts.generation) return;
    engineLoadTrackAtPosition({ ...opts, track });
  })();
}
