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
  subscribePlaybackSeek,
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
/** Track the current anchor belongs to. A boundary reports currentTime 0 with
 *  buffering set, and that zero is real — without this the estimate would hold
 *  the previous track's end position into the new one. */
let anchoredTrackId: string | null = null;

/** Position the last real update reported, advanced by elapsed time while
 *  playback is running. */
/** The position the engine last reported. While buffering the progress
 *  snapshot carries 0, so the store's committed position — coarse but real —
 *  stands in for it. */
function reportedPosition(): number {
  const snapshot = getPlaybackProgressSnapshot();
  return snapshot.buffering
    ? usePlayerStore.getState().currentTime
    : snapshot.currentTime;
}

export function getSmoothPlaybackTime(): number {
  // Consumers read this once before subscribing, and the module only anchors
  // itself once it has a listener. Without this fallback that first read would
  // return a stale module global — or zero on the very first mount.
  if (unsubscribeSources == null) return reportedPosition();
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

/** The effective rate also depends on the Orbit session, which changes
 *  without a rate-store write, so the value is re-checked as frames run. */
function syncRateIfChanged(): void {
  const rate = effectivePlaybackRate();
  if (rate === anchoredRate) return;
  anchor(getSmoothPlaybackTime(), extrapolating);
  lastKnownRate = rate;
}

function tick(): void {
  frame = null;
  if (listeners.size === 0) return;
  // Same guard the waveform interpolation uses: a Tauri window the app counts
  // as hidden may still be composited, so skip the work but keep the loop.
  if (document.hidden || window.__psyHidden) {
    frame = requestAnimationFrame(tick);
    return;
  }
  syncRateIfChanged();
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
  anchoredTrackId = usePlayerStore.getState().currentTrack?.id ?? null;
  anchor(reportedPosition(), isMoving(snapshot.buffering));

  const offProgress = subscribePlaybackProgress(next => {
    const trackId = usePlayerStore.getState().currentTrack?.id ?? null;
    const sameTrack = trackId === anchoredTrackId;
    anchoredTrackId = trackId;

    if (next.buffering && sameTrack) {
      // Mid-track buffering reports currentTime as 0, so the reported value
      // must not be trusted — freeze where we are. A track boundary also
      // reports 0 with buffering set, but there the zero is the truth, which
      // is why this only applies while the track is unchanged.
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
  // A seek is the one position change the engine does not announce — and
  // while paused it never would, so the views would sit on the old line.
  const offSeek = subscribePlaybackSeek(seconds => {
    anchor(seconds, isMoving(getPlaybackProgressSnapshot().buffering));
    emit(true);
    startFrameLoop();
  });

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
    offSeek();
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
  anchoredTrackId = null;
}
