import { invoke } from '@tauri-apps/api/core';
import { isRecoverableSeekError } from '../utils/seekErrors';
import { usePlayerStore } from './playerStore';
import { setSeekTarget } from './seekTargetState';

/**
 * Streaming-fallback seek recovery + visual coverup.
 *
 * The Rust seek pipeline can reject a seek as "not seekable" while the
 * stream is still settling (sink not bound yet, codec hasn't reported
 * seekability). Instead of surfacing the failure straight away, this
 * module schedules bounded retries every 180 ms up to a 6 s ceiling.
 *
 * In parallel, `seekFallbackVisualTarget` holds the seekbar at the
 * requested position so the user doesn't see it snap back to the
 * pre-seek time while the retry loop is in flight. The progress handler
 * reads this and prefers the target value until the engine actually
 * reaches it (within ~2 s) or the 1.6 s visual-guard window elapses.
 *
 * `seekFallbackTrackId` + `seekFallbackRestartAt` track the most recent
 * fallback-restart so a quick subsequent seek on the same track can
 * decide whether to debounce a full restart vs reuse the loop.
 */

export const SEEK_FALLBACK_VISUAL_GUARD_MS = 1600;
export const SEEK_FALLBACK_RETRY_INTERVAL_MS = 180;
export const SEEK_FALLBACK_RETRY_MAX_MS = 6000;

let seekFallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
let seekFallbackRetryStartedAt = 0;
let seekFallbackRetryTarget: { trackId: string; seconds: number } | null = null;
let seekFallbackTrackId: string | null = null;
let seekFallbackRestartAt = 0;
let seekFallbackVisualTarget: { trackId: string; seconds: number; setAtMs: number } | null = null;

export function clearSeekFallbackRetry(): void {
  if (seekFallbackRetryTimer) {
    clearTimeout(seekFallbackRetryTimer);
    seekFallbackRetryTimer = null;
  }
  seekFallbackRetryStartedAt = 0;
  seekFallbackRetryTarget = null;
}

export function scheduleSeekFallbackRetry(trackId: string, seconds: number): void {
  const now = Date.now();
  if (
    !seekFallbackRetryTarget
    || seekFallbackRetryTarget.trackId !== trackId
    || Math.abs(seekFallbackRetryTarget.seconds - seconds) > 0.25
  ) {
    clearSeekFallbackRetry();
    seekFallbackRetryStartedAt = now;
    seekFallbackRetryTarget = { trackId, seconds };
  } else if (seekFallbackRetryStartedAt === 0) {
    seekFallbackRetryStartedAt = now;
  }
  if (seekFallbackRetryTimer) clearTimeout(seekFallbackRetryTimer);
  seekFallbackRetryTimer = setTimeout(() => {
    seekFallbackRetryTimer = null;
    const target = seekFallbackRetryTarget;
    const s = usePlayerStore.getState();
    if (!target || !s.currentTrack || s.currentTrack.id !== target.trackId) {
      clearSeekFallbackRetry();
      return;
    }
    if (Date.now() - seekFallbackRetryStartedAt > SEEK_FALLBACK_RETRY_MAX_MS) {
      clearSeekFallbackRetry();
      seekFallbackVisualTarget = null;
      return;
    }
    invoke('audio_seek', { seconds: target.seconds }).then(() => {
      setSeekTarget(target.seconds);
      seekFallbackVisualTarget = null;
      clearSeekFallbackRetry();
    }).catch((err: unknown) => {
      const msg = String(err ?? '');
      if (!isRecoverableSeekError(msg)) {
        console.error(err);
        seekFallbackVisualTarget = null;
        clearSeekFallbackRetry();
        return;
      }
      scheduleSeekFallbackRetry(target.trackId, target.seconds);
    });
  }, SEEK_FALLBACK_RETRY_INTERVAL_MS);
}

export type SeekFallbackVisualTarget = {
  trackId: string;
  seconds: number;
  setAtMs: number;
};

export function getSeekFallbackVisualTarget(): SeekFallbackVisualTarget | null {
  return seekFallbackVisualTarget;
}

export function setSeekFallbackVisualTarget(target: SeekFallbackVisualTarget | null): void {
  seekFallbackVisualTarget = target;
}

export function getSeekFallbackTrackId(): string | null {
  return seekFallbackTrackId;
}

export function setSeekFallbackTrackId(id: string | null): void {
  seekFallbackTrackId = id;
}

export function getSeekFallbackRestartAt(): number {
  return seekFallbackRestartAt;
}

export function setSeekFallbackRestartAt(t: number): void {
  seekFallbackRestartAt = t;
}

/** Test-only: reset every mutable to its initial value. */
export function _resetSeekFallbackStateForTest(): void {
  if (seekFallbackRetryTimer) clearTimeout(seekFallbackRetryTimer);
  seekFallbackRetryTimer = null;
  seekFallbackRetryStartedAt = 0;
  seekFallbackRetryTarget = null;
  seekFallbackTrackId = null;
  seekFallbackRestartAt = 0;
  seekFallbackVisualTarget = null;
}
