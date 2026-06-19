import { invoke } from '@tauri-apps/api/core';
import type { Track } from '../../store/playerStoreTypes';
import {
  INTERRUPT_BLEND_PREP_FADE_SEC,
  isCrossfadeNextReady,
  kickEagerCrossfadePreload,
  waitForCrossfadeNextReady,
} from '../../store/crossfadePreload';

export { INTERRUPT_BLEND_PREP_FADE_SEC };

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
 * `outgoingFadeSec: 0` on the blend plan — A is already fading.
 */
export async function runInterruptBlendPrep(
  track: Track,
  profileId: string | null,
  cacheKey: string | null,
  isStale: () => boolean,
): Promise<InterruptBlendPrepResult> {
  kickEagerCrossfadePreload(track, profileId, cacheKey);
  void invoke('audio_begin_outgoing_fade', { fadeSecs: INTERRUPT_BLEND_PREP_FADE_SEC }).catch(() => {});

  const prepMs = Math.round(INTERRUPT_BLEND_PREP_FADE_SEC * 1000);
  await Promise.all([
    sleepMs(prepMs),
    waitForCrossfadeNextReady(track.id, profileId, cacheKey, prepMs, isStale),
  ]);
  if (isStale()) return { ready: false };
  return { ready: isCrossfadeNextReady(track.id, profileId, cacheKey) };
}
