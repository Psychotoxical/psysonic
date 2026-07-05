import { audioPreload } from '@/lib/api/audio';
import { useAuthStore } from '@/store/authStore';
import { autodjMaxOverlapCapSec } from '@/lib/audio/autodjOverlapCap';
import { computeWaveformSilence, planCrossfadeTransition } from '@/lib/waveform/waveformSilence';
import { findLocalPlaybackUrl } from '@/store/localPlaybackResolve';
import { playbackCacheKeyForRef } from '@/features/playback/utils/playback/playbackServer';
import { resolvePlaybackUrl } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import type { Track } from '@/lib/media/trackTypes';
import {
  hasPlannedCrossfade,
  markPlannedCrossfade,
  setCrossfadeTransition,
} from '@/features/playback/store/crossfadeTrimCache';
import { getBytePreloadingId, setBytePreloadingId } from '@/features/playback/store/gaplessPreloadState';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { fetchWaveformBins } from '@/features/playback/store/waveformRefresh';

// Crossfade pre-buffer budget: begin downloading the next track this many
// seconds before it needs to play (the crossfade start), so a large lossless
// file over HTTP has time to buffer + promote to cache before the fade. Generous
// on purpose. The trailing-silence trim widens the window further so the early
// A-tail advance keeps the full budget.
export const CROSSFADE_PRELOAD_BUDGET_SECS = 30;

/**
 * Readiness gate for the AutoDJ early, content-driven advance. A stable fade
 * needs the *next* track's audio at the overlap moment — analysis (waveform)
 * alone is not enough. B counts as ready when its full bytes are in the engine
 * RAM preload slot (`enginePreloadedTrackId`) or it is local on disk: offline
 * library, favourite auto-sync, or hot-cache ephemeral tier. When B isn't ready
 * we skip the early advance and let the plain engine crossfade handle the
 * transition (graceful degrade) instead of fading over a buffering stream.
 */
export function isCrossfadeNextReady(
  trackId: string,
  profileId: string | null,
  cacheKey: string | null,
): boolean {
  if (!trackId) return false;
  if (usePlayerStore.getState().enginePreloadedTrackId === trackId) return true;
  for (const sid of [profileId, cacheKey]) {
    if (!sid) continue;
    if (
      findLocalPlaybackUrl(trackId, sid, 'library')
      || findLocalPlaybackUrl(trackId, sid, 'favorite-auto')
      || findLocalPlaybackUrl(trackId, sid, 'ephemeral')
    ) {
      return true;
    }
  }
  return false;
}

/** Outgoing fade + preload window before an interrupt handoff (library pick, etc.). */
export const INTERRUPT_BLEND_PREP_FADE_SEC = 1.0;

/** @deprecated Use {@link INTERRUPT_BLEND_PREP_FADE_SEC} — prep and wait are aligned. */
export const INTERRUPT_BLEND_PRELOAD_WAIT_MS = Math.round(INTERRUPT_BLEND_PREP_FADE_SEC * 1000);

/**
 * Start an eager RAM preload for a track the user just picked (no queue lead time).
 * No-op when already ready or a preload for this id is in flight.
 */
export function kickEagerCrossfadePreload(
  track: Track,
  profileId: string | null,
  cacheKey: string | null,
): void {
  if (isCrossfadeNextReady(track.id, profileId, cacheKey)) return;
  if (track.id === getBytePreloadingId()) return;
  const serverId = cacheKey || profileId;
  const url = resolvePlaybackUrl(track.id, serverId ?? undefined);
  setBytePreloadingId(track.id);
  void refreshLoudnessForTrack(track.id, { syncPlayingEngine: false });
  audioPreload({
    url,
    durationHint: track.duration,
    analysisTrackId: track.id,
    serverId: serverId || null,
    eager: true,
  }).catch(() => {});
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms); });
}

/**
 * Poll until B is playable for a stable crossfade, or `maxWaitMs` elapses.
 * Returns false when `isStale()` reports a superseding play generation.
 */
export async function waitForCrossfadeNextReady(
  trackId: string,
  profileId: string | null,
  cacheKey: string | null,
  maxWaitMs: number,
  isStale: () => boolean,
): Promise<boolean> {
  if (isCrossfadeNextReady(trackId, profileId, cacheKey)) return true;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (isStale()) return false;
    await sleepMs(50);
    if (isCrossfadeNextReady(trackId, profileId, cacheKey)) return true;
  }
  return isCrossfadeNextReady(trackId, profileId, cacheKey);
}

/**
 * Crossfade-only byte pre-download for the next track + (when trim is on) its
 * leading-silence probe. Self-gating and idempotent (`bytePreloadingId` /
 * `hasFetchedCrossfadeLead` guards), so it is safe to call every progress tick
 * *and* immediately after a seek lands inside the pre-buffer window. No-ops for
 * the gapless / hot-cache paths (those pre-buffer elsewhere).
 *
 * Lives in its own module so `seekAction` can call it without pulling in
 * `audioEventHandlers` (which would close a `playerStore` import cycle).
 */
export function maybeCrossfadeBytePreload(currentTime: number, dur: number): void {
  if (!(dur > 0)) return;
  const {
    gaplessEnabled, hotCacheEnabled, crossfadeEnabled, crossfadeSecs, crossfadeTrimSilence,
  } = useAuthStore.getState();
  if (!crossfadeEnabled || gaplessEnabled) return;

  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (!track || store.currentRadio) return;
  const remaining = dur - currentTime;
  if (!(remaining > 0)) return;

  const curTrailSilenceSec = crossfadeTrimSilence
    ? computeWaveformSilence(store.waveformBins, dur).trailSilenceSec
    : 0;
  const crossfadeWindowSecs = crossfadeSecs + curTrailSilenceSec + CROSSFADE_PRELOAD_BUDGET_SECS;
  if (remaining >= crossfadeWindowSecs) return;

  const { queueItems, queueIndex, repeatMode } = store;
  if (repeatMode === 'one') return;
  const nextIdx = queueIndex + 1;
  const nextRef = nextIdx < queueItems.length
    ? queueItems[nextIdx]
    : (repeatMode === 'all' && queueItems.length > 0 ? queueItems[0] : null);
  if (!nextRef) return;
  const nextTrack = resolveQueueTrack(nextRef);
  if (!nextTrack || nextTrack.id === track.id) return;

  const serverId = playbackCacheKeyForRef(nextRef);
  const nextUrl = resolvePlaybackUrl(nextTrack.id, serverId);

  // Byte pre-download — skipped when the hot cache is on (it already keeps the
  // upcoming queue on disk, which is also why hot cache makes the trim reliable:
  // the next track is local → seekable → starts instantly past its lead silence).
  if (!hotCacheEnabled && nextTrack.id !== getBytePreloadingId()) {
    setBytePreloadingId(nextTrack.id);
    // Loudness cache only — never refreshWaveformForTrack(next): it writes the
    // global waveformBins and would replace the current track's seekbar.
    void refreshLoudnessForTrack(nextTrack.id, { syncPlayingEngine: false });
    audioPreload({
      url: nextUrl,
      durationHint: nextTrack.duration,
      analysisTrackId: nextTrack.id,
      serverId: serverId || null,
      // Crossfade/AutoDJ pre-buffer: skip the 8 s throttle so the RAM slot
      // fills before the fade — without the hot cache this is the only source
      // of B's bytes, and a late slot means no fade (or an audible jump).
      eager: true,
    }).catch(() => {});
  }

  // B-head + dynamic overlap: plan the whole transition once (no store write) so
  // playTrack can start the incoming track past its dead head AND fade over a
  // content-adaptive overlap. Pairs the current track's envelope (already in the
  // store) with the next track's cached waveform; the alignment maths is cheap,
  // so it runs regardless of hot cache (which otherwise skips the byte
  // pre-download). Cold/un-analysed tracks fall back to a fixed overlap + no
  // head trim → today's behaviour.
  if (crossfadeTrimSilence && !hasPlannedCrossfade(nextTrack.id)) {
    markPlannedCrossfade(nextTrack.id);
    const planTrackId = nextTrack.id;
    const planDuration = nextTrack.duration;
    const curBins = store.waveformBins;
    void fetchWaveformBins(planTrackId, serverId || null)
      .then(nextBins => {
        // Overlap is derived purely from the audio (fade-out / buildup); the
        // user's crossfadeSecs is intentionally not a factor in this mode.
        const maxOverlapSec = autodjMaxOverlapCapSec(useAuthStore.getState());
        const plan = planCrossfadeTransition(curBins, dur, nextBins, planDuration, { maxOverlapSec });
        setCrossfadeTransition(planTrackId, plan);
      })
      .catch(() => {});
  }
}
