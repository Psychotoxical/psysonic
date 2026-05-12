/**
 * Three time-based throttles used by the audio-progress handler so it
 * doesn't saturate the WebView2 renderer with redundant emits / setState
 * commits on a noisy `audio:progress` stream:
 *
 *  - **Live progress emit** — feeds the high-frequency `playbackProgress`
 *    pub/sub. Gate: 1.5 s elapsed OR ≥0.9 s position delta.
 *  - **Store progress commit** — writes the Zustand player store. Gate:
 *    20 s elapsed OR ≥5 s position delta. Heavier than the live emit
 *    because subscribers to the store re-render.
 *  - **Normalization UI update** — 120 ms throttle on the live dB readout
 *    written to the store during a track.
 *
 * The progress emit + commit pair share `resetProgressEmitThrottles` so
 * the runtime can force a fresh emit/commit immediately after a track
 * boundary (`handleAudioPlaying`).
 */

export const LIVE_PROGRESS_EMIT_MIN_MS = 1500;
export const LIVE_PROGRESS_EMIT_MIN_DELTA_SEC = 0.9;
export const STORE_PROGRESS_COMMIT_MIN_MS = 20_000;
export const STORE_PROGRESS_COMMIT_MIN_DELTA_SEC = 5.0;
export const NORMALIZATION_UI_THROTTLE_MS = 120;

let lastLiveProgressEmitAt = 0;
let lastStoreProgressCommitAt = 0;
let lastNormalizationUiUpdateAtMs = 0;

export function getLastLiveProgressEmitAt(): number {
  return lastLiveProgressEmitAt;
}

export function markLiveProgressEmit(nowMs: number): void {
  lastLiveProgressEmitAt = nowMs;
}

export function getLastStoreProgressCommitAt(): number {
  return lastStoreProgressCommitAt;
}

export function markStoreProgressCommit(nowMs: number): void {
  lastStoreProgressCommitAt = nowMs;
}

export function getLastNormalizationUiUpdateAtMs(): number {
  return lastNormalizationUiUpdateAtMs;
}

export function markNormalizationUiUpdate(nowMs: number): void {
  lastNormalizationUiUpdateAtMs = nowMs;
}

/** Reset the two progress throttles — used by `handleAudioPlaying` so the first emit + commit after a track boundary go through immediately. */
export function resetProgressEmitThrottles(): void {
  lastLiveProgressEmitAt = 0;
  lastStoreProgressCommitAt = 0;
}

/** Test-only: wipe all three timestamps so each spec starts fresh. */
export function _resetPlaybackThrottlesForTest(): void {
  lastLiveProgressEmitAt = 0;
  lastStoreProgressCommitAt = 0;
  lastNormalizationUiUpdateAtMs = 0;
}
