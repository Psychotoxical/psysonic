import { invoke } from '@tauri-apps/api/core';
import { computeWaveformSilence, planCrossfadeTransition } from '../utils/waveform/waveformSilence';
import { playbackCacheKeyForRef } from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveQueueTrack } from '../utils/library/queueTrackView';
import { useAuthStore } from './authStore';
import {
  hasPlannedCrossfade,
  markPlannedCrossfade,
  setCrossfadeTransition,
} from './crossfadeTrimCache';
import { getBytePreloadingId, setBytePreloadingId } from './gaplessPreloadState';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { usePlayerStore } from './playerStore';
import { fetchWaveformBins } from './waveformRefresh';

// Crossfade pre-buffer budget: begin downloading the next track this many
// seconds before it needs to play (the crossfade start), so a large lossless
// file over HTTP has time to buffer + promote to cache before the fade. Generous
// on purpose. The trailing-silence trim widens the window further so the early
// A-tail advance keeps the full budget.
export const CROSSFADE_PRELOAD_BUDGET_SECS = 30;

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
    invoke('audio_preload', {
      url: nextUrl,
      durationHint: nextTrack.duration,
      analysisTrackId: nextTrack.id,
      serverId: serverId || null,
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
        const plan = planCrossfadeTransition(curBins, dur, nextBins, planDuration);
        setCrossfadeTransition(planTrackId, plan);
      })
      .catch(() => {});
  }
}
