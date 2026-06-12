import type { Track } from './playerStoreTypes';
import { engineLoadTrackAtPosition } from './engineLoadTrackAtPosition';

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
  engineLoadTrackAtPosition(opts);
}
