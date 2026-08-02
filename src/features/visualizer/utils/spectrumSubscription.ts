/**
 * Refcounted lifecycle for the Rust spectrum feed.
 *
 * Several surfaces can show a visualizer at once (the Now Playing card and the
 * fullscreen player, for instance). Rust only needs to be told "someone is
 * watching" — so this module owns a single count and calls across the boundary
 * only on the 0↔1 edges. Everything else would put an FFT task and a 60 Hz
 * event stream on the IPC pipe for nothing.
 *
 * Failures are swallowed deliberately: a visualizer that can't start is a
 * cosmetic loss, and throwing here would surface as an unhandled rejection in
 * a component effect.
 */

import { audioSpectrumSetActive } from '@/lib/api/audio';

/** Feed shape the engine should produce. */
export interface SpectrumFeedParams {
  fps: number;
  /** Envelope responsiveness, 0 (smooth) to 1 (snappy). */
  responsiveness: number;
}

let refCount = 0;
let params: SpectrumFeedParams = { fps: 60, responsiveness: 0.65 };
/** Serialises the boundary calls so a fast mount/unmount can't land out of order. */
let pending: Promise<void> = Promise.resolve();

function push(active: boolean): void {
  const snapshot = { ...params };
  pending = pending
    .then(() => audioSpectrumSetActive({ active, ...snapshot }))
    .catch(() => { /* visualizer is cosmetic — never break the caller */ });
}

/**
 * Register a watcher. Returns a release function; calling it more than once is
 * a no-op so a double-invoked React cleanup can't drive the count negative.
 */
export function acquireSpectrumFeed(next: SpectrumFeedParams): () => void {
  params = { ...next };
  refCount += 1;
  if (refCount === 1) push(true);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) push(false);
  };
}

/** Update the feed shape while watchers are attached. */
export function setSpectrumFeedParams(next: SpectrumFeedParams): void {
  if (next.fps === params.fps && next.responsiveness === params.responsiveness) return;
  params = { ...next };
  if (refCount > 0) push(true);
}

export function _spectrumFeedRefCountForTest(): number {
  return refCount;
}

export function _resetSpectrumFeedForTest(): void {
  refCount = 0;
  params = { fps: 60, responsiveness: 0.65 };
  pending = Promise.resolve();
}
