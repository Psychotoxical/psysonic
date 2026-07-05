import { audioBeginOutgoingFade } from '@/lib/api/audio';
import type { Track } from '@/lib/media/trackTypes';
import {
  INTERRUPT_BLEND_PREP_FADE_SEC,
  isCrossfadeNextReady,
  kickEagerCrossfadePreload,
  waitForCrossfadeNextReady,
} from '@/features/playback/store/crossfadePreload';

export { INTERRUPT_BLEND_PREP_FADE_SEC };

/** Play generation with a pending interrupt handoff (suppress spurious `audio:ended`). */
let pendingHandoffGen: number | null = null;

export function armInterruptHandoff(gen: number): void {
  pendingHandoffGen = gen;
}

export function clearInterruptHandoff(): void {
  pendingHandoffGen = null;
}

export function isInterruptHandoffPending(): boolean {
  return pendingHandoffGen !== null;
}

/** Keep player-bar metadata on A until B is buffered and the engine handoff runs. */
export function shouldDeferInterruptHandoffUi(
  wantInterruptBlend: boolean,
  bReadyNow: boolean,
): boolean {
  return wantInterruptBlend && !bReadyNow;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms); });
}

export interface InterruptBlendPrepResult {
  /** B is playable for a stable crossfade handoff. */
  ready: boolean;
}

/**
 * Win preload time before the incoming track starts: fade the outgoing engine
 * source for ~1 s while eagerly buffering B. Caller should pass
 * `outgoingFadeSec: 0` on the blend plan when prep ran — A was volume-ducked only.
 */
export async function runInterruptBlendPrep(
  track: Track,
  profileId: string | null,
  cacheKey: string | null,
  isStale: () => boolean,
): Promise<InterruptBlendPrepResult> {
  kickEagerCrossfadePreload(track, profileId, cacheKey);
  void audioBeginOutgoingFade({ fadeSecs: INTERRUPT_BLEND_PREP_FADE_SEC }).catch(() => {});

  const prepMs = Math.round(INTERRUPT_BLEND_PREP_FADE_SEC * 1000);
  await Promise.all([
    sleepMs(prepMs),
    waitForCrossfadeNextReady(track.id, profileId, cacheKey, prepMs, isStale),
  ]);
  if (isStale()) return { ready: false };
  return { ready: isCrossfadeNextReady(track.id, profileId, cacheKey) };
}
