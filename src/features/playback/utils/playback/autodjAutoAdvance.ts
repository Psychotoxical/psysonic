import { DYNAMIC_OVERLAP_HARD_CAP_SEC, STANDARD_BLEND_SEC } from '@/lib/waveform/waveformSilence';
import type { QueueItemRef } from '@/lib/media/trackTypes';

export type QueueRepeatMode = 'off' | 'all' | 'one';

/** Next queue slot AutoDJ / silence-aware crossfade may hand off to, if any. */
export function nextQueueRefForTransition(
  queueItems: QueueItemRef[],
  queueIndex: number,
  repeatMode: QueueRepeatMode,
): QueueItemRef | null {
  if (repeatMode === 'one') return null;
  const nextIdx = queueIndex + 1;
  if (nextIdx < queueItems.length) return queueItems[nextIdx] ?? null;
  if (repeatMode === 'all' && queueItems.length > 0) return queueItems[0] ?? null;
  return null;
}

/** Clamp engine crossfade setting to the same bounds used in progress handling. */
export function clampCrossfadeSecs(crossfadeSecs: number): number {
  return Math.max(0.1, Math.min(12, crossfadeSecs));
}

/**
 * Whether the JS A-tail advance should drive this transition (and suppress the
 * engine's autonomous crossfade timer). True for dead-air skips, long fades, and
 * plain loud→loud; false only when A rides its own recorded fade and the engine
 * window is not earlier than the content overlap.
 */
export function shouldJsDriveAutodjTransition(
  curTrailSilenceSec: number,
  contentOverlap: number,
  crossfadeSecs: number,
  aRidesOwnFade: boolean,
): boolean {
  const cf = clampCrossfadeSecs(crossfadeSecs);
  const wantEarly = curTrailSilenceSec > 0.3 || contentOverlap > cf + 0.3;
  return wantEarly || !aRidesOwnFade;
}

/** Content-driven overlap for a JS-driven AutoDJ handoff. */
export function computeAutodjJsOverlap(
  contentOverlap: number,
  aRidesOwnFade: boolean,
  maxCapSec = DYNAMIC_OVERLAP_HARD_CAP_SEC,
): { overlapSec: number; outgoingFadeSec: number } {
  let overlap = Math.max(0.5, Math.min(maxCapSec, contentOverlap || 0.5));
  if (!aRidesOwnFade && overlap < STANDARD_BLEND_SEC) overlap = STANDARD_BLEND_SEC;
  const outgoingFadeSec = aRidesOwnFade ? 0 : overlap;
  return { overlapSec: overlap, outgoingFadeSec };
}

/** Playback time when the JS advance should fire (blend ends at A content end). */
export function autodjJsTriggerAtSec(
  durationSec: number,
  trailSilenceSec: number,
  overlapSec: number,
): number {
  return Math.max(0, durationSec - trailSilenceSec - overlapSec);
}
