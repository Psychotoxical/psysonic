/**
 * Sub-second playback position for consumers that need it.
 *
 * `playbackProgress` is throttled twice on the way here — once in the Rust
 * progress task and again in the audio event handler — so a subscriber sees a
 * new position roughly every 0.9 s. That is invisible on a mm:ss clock but not
 * in synced lyrics, where a line can light up close to a second late depending
 * on where it falls between two updates.
 *
 * Rather than loosen either throttle, which would cost every subscriber, this
 * advances the last reported position locally: base time plus elapsed
 * wall-clock, scaled by the playback rate. Each real update re-anchors the
 * base, so the estimate never drifts further than one update apart. The frame
 * loop only runs while something is subscribed and playback is actually
 * moving.
 */
import {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
} from '@/features/playback/store/playbackProgress';
import { effectivePlaybackRate } from '@/features/playback/store/playbackReportSession';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';

/** Never extrapolate further than this past the last real update. Bounds the
 *  error if updates stop arriving (stall, suspended timers) instead of letting
 *  the estimate run away. */
const MAX_EXTRAPOLATION_SEC = 2;

/** Lower bound between pushes. Frame rate is far finer than anyone can
 *  perceive in a highlighted lyric, and the raw channel this replaces ran at
 *  roughly one update per second — 30 ms keeps the gain and drops the churn. */
const EMIT_MIN_INTERVAL_MS = 30;

type Listener = (seconds: number) => void;

const listeners = new Set<Listener>();

let baseSeconds = 0;
let baseAtMs = 0;
let extrapolating = false;
/** Rate in force since the last anchor. Read live, a rate change would apply
 *  the new value to time already elapsed at the old one. */
let anchoredRate = 1;
let frame: number | null = null;
let unsubscribeSources: (() => void) | null = null;
let lastKnownPlaying = false;
let lastKnownPreviewing = false;
let lastKnownRate = 1;
let lastEmitAtMs = Number.NEGATIVE_INFINITY;

/** Position the last real update reported, advanced by elapsed time while
 *  playback is running. */
export function getSmoothPlaybackTime(): number {
  // Consumers read this once before subscribing, and the module only anchors
  // itself once it has a listener. Without this fallback that first read would
  // return a stale module global — or zero on the very first mount.
  if (unsubscribeSources == null) return getPlaybackProgressSnapshot().currentTime;
  if (!extrapolating) return baseSeconds;
  const elapsed = (performance.now() - baseAtMs) / 1000;
  // Clamp the media position, not the wall clock: at 2x the latter would allow
  // twice the drift the cap is meant to permit.
  const advanced = Math.min(elapsed * anchoredRate, MAX_EXTRAPOLATION_SEC);
  return baseSeconds + Math.max(0, advanced);
}

function anchor(seconds: number, moving: boolean): void {
  baseSeconds = seconds;
  baseAtMs = performance.now();
  extrapolating = moving;
  anchoredRate = effectivePlaybackRate();
}

/** `force` is for real state changes (engine update, pause, rate) — those
 *  must reach subscribers regardless of when the last frame went out. */
function emit(force = false): void {
  const now = performance.now();
  if (!force && now - lastEmitAtMs < EMIT_MIN_INTERVAL_MS) return;
  lastEmitAtMs = now;
  const value = getSmoothPlaybackTime();
  listeners.forEach(cb => cb(value));
}

/** True once the estimate sits at the cap: from here it cannot change until
 *  a real update arrives, so running frames would push a constant value. */
function capReached(): boolean {
  const elapsed = (performance.now() - baseAtMs) / 1000;
  return elapsed * anchoredRate >= MAX_EXTRAPOLATION_SEC;
}

function tick(): void {
  frame = null;
  if (listeners.size === 0) return;
  emit();
  if (extrapolating && !capReached()) frame = requestAnimationFrame(tick);
}

function startFrameLoop(): void {
  if (frame == null && extrapolating && listeners.size > 0 && !capReached()) {
    frame = requestAnimationFrame(tick);
  }
}

function isMoving(buffering: boolean | undefined): boolean {
  // A running track preview pauses the main sink in Rust while `isPlaying`
  // stays true and progress events stop — the same guard the waveform uses.
  if (usePreviewStore.getState().previewingId != null) return false;
  return usePlayerStore.getState().isPlaying && !buffering;
}

function attachSources(): void {
  const snapshot = getPlaybackProgressSnapshot();
  lastKnownPlaying = usePlayerStore.getState().isPlaying;
  lastKnownPreviewing = usePreviewStore.getState().previewingId != null;
  lastKnownRate = effectivePlaybackRate();
  anchor(snapshot.currentTime, isMoving(snapshot.buffering));

  const offProgress = subscribePlaybackProgress(next => {
    if (next.buffering) {
      // audioEventHandlers reports currentTime as 0 while buffering, so the
      // reported value must not be trusted here — freeze where we are.
      anchor(getSmoothPlaybackTime(), false);
    } else {
      anchor(next.currentTime, isMoving(next.buffering));
    }
    emit(true);
    startFrameLoop();
  });

  // Pausing stops the position without producing a progress event, so the
  // player state has to re-anchor as well — otherwise the estimate would keep
  // advancing through a pause.
  const reanchor = (): void => {
    const moving = isMoving(getPlaybackProgressSnapshot().buffering);
    anchor(getSmoothPlaybackTime(), moving);
    emit(true);
    startFrameLoop();
  };

  const offPlayer = usePlayerStore.subscribe(state => {
    if (state.isPlaying === lastKnownPlaying) return;
    lastKnownPlaying = state.isPlaying;
    reanchor();
  });

  const offPreview = usePreviewStore.subscribe(state => {
    const previewing = state.previewingId != null;
    if (previewing === lastKnownPreviewing) return;
    lastKnownPreviewing = previewing;
    reanchor();
  });

  // A rate change must re-anchor before it takes effect: the estimate is
  // base + elapsed x rate, so applying a new rate to time already elapsed at
  // the old one would retroactively rescale the whole window and jump.
  const offRate = usePlaybackRateStore.subscribe(() => {
    const rate = effectivePlaybackRate();
    if (rate === lastKnownRate) return;
    lastKnownRate = rate;
    reanchor();
  });

  unsubscribeSources = () => {
    offProgress();
    offPlayer();
    offPreview();
    offRate();
  };
  startFrameLoop();
}

function detachSources(): void {
  unsubscribeSources?.();
  unsubscribeSources = null;
  if (frame != null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
}

/** Subscribe to the interpolated position. Mirrors `subscribePlaybackProgress`
 *  so a consumer only swaps which channel it listens to. */
export function subscribeSmoothPlaybackTime(cb: Listener): () => void {
  listeners.add(cb);
  if (listeners.size === 1) attachSources();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) detachSources();
  };
}

/** Test-only: drop all state so specs stay isolated. */
export function _resetSmoothPlaybackTimeForTest(): void {
  detachSources();
  listeners.clear();
  baseSeconds = 0;
  baseAtMs = 0;
  extrapolating = false;
  anchoredRate = 1;
  lastKnownPlaying = false;
  lastKnownPreviewing = false;
  lastKnownRate = 1;
  lastEmitAtMs = Number.NEGATIVE_INFINITY;
}
