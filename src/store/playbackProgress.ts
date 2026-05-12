/**
 * High-frequency playback-progress channel. Decoupled from the main Zustand
 * store so subscribers (waveform, time labels, lyrics scroller, mini player
 * mirror) can re-render on every audio tick without invalidating selectors
 * that watch unrelated player state.
 *
 * `emitPlaybackProgress` short-circuits when the next snapshot is within a
 * sub-perceptible delta of the previous one — keeps idle CPU bounded when
 * the player is paused or the engine reports identical frames in a row.
 */
export type PlaybackProgressSnapshot = {
  currentTime: number;
  progress: number;
  buffered: number;
};

let playbackProgressSnapshot: PlaybackProgressSnapshot = {
  currentTime: 0,
  progress: 0,
  buffered: 0,
};

const playbackProgressListeners = new Set<(
  next: PlaybackProgressSnapshot,
  prev: PlaybackProgressSnapshot,
) => void>();

export function emitPlaybackProgress(next: PlaybackProgressSnapshot): void {
  const prev = playbackProgressSnapshot;
  if (
    Math.abs(prev.currentTime - next.currentTime) < 0.005 &&
    Math.abs(prev.progress - next.progress) < 0.0002 &&
    Math.abs(prev.buffered - next.buffered) < 0.0002
  ) {
    return;
  }
  playbackProgressSnapshot = next;
  playbackProgressListeners.forEach(cb => cb(next, prev));
}

export function getPlaybackProgressSnapshot(): PlaybackProgressSnapshot {
  return playbackProgressSnapshot;
}

export function subscribePlaybackProgress(
  cb: (next: PlaybackProgressSnapshot, prev: PlaybackProgressSnapshot) => void,
): () => void {
  playbackProgressListeners.add(cb);
  return () => {
    playbackProgressListeners.delete(cb);
  };
}

/** Test-only: reset module state between specs so suites stay isolated. */
export function _resetPlaybackProgressForTest(): void {
  playbackProgressSnapshot = { currentTime: 0, progress: 0, buffered: 0 };
  playbackProgressListeners.clear();
}
