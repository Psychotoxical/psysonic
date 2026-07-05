/**
 * Debounce timer for seek-slider drags. The waveform / seekbar emit a
 * seek event for every pixel of cursor movement; without debouncing each
 * one would hit `audio_seek` and the engine would thrash. The 100 ms
 * window in `playerStore.seek` collapses rapid drags into one actual
 * seek call.
 *
 * `isSeekDebouncePending` is the guard the progress handler reads to
 * suppress stale ticks during a drag: the slider's local set already
 * paints the target position, so a Rust progress event for the old
 * playhead would snap the UI back.
 */

let seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function isSeekDebouncePending(): boolean {
  return seekDebounceTimer !== null;
}

export function armSeekDebounce(delayMs: number, onFire: () => void): void {
  if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
  seekDebounceTimer = setTimeout(() => {
    seekDebounceTimer = null;
    onFire();
  }, delayMs);
}

export function clearSeekDebounce(): void {
  if (seekDebounceTimer) {
    clearTimeout(seekDebounceTimer);
    seekDebounceTimer = null;
  }
}

/** Test-only: force-clear without firing the callback. */
export function _resetSeekDebounceForTest(): void {
  clearSeekDebounce();
}
