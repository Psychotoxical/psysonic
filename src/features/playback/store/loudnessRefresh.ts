import { buildStreamUrl } from '@/lib/api/subsonicStreamUrl';
import { commands } from '@/generated/bindings';
import { getPlaybackIndexKey } from '@/features/playback/utils/playback/playbackServer';
import { redactSubsonicUrlForLog } from '@/lib/server/redactSubsonicUrl';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { emitNormalizationDebug } from '@/features/playback/store/normalizationDebug';
import {
  forgetLoudnessGain,
  markLoudnessStable,
} from '@/features/playback/store/loudnessGainCache';
import {
  MAX_BACKFILL_ATTEMPTS_PER_TRACK,
  clearBackfillInFlight,
  getBackfillAttempts,
  isBackfillInFlight,
  markBackfillInFlight,
  resetBackfillAttempts,
} from '@/features/playback/store/loudnessBackfillState';
import {
  LOUDNESS_BACKFILL_WINDOW_AHEAD,
  isTrackInsideLoudnessBackfillWindow,
  loudnessBackfillPriorityForTrack,
} from '@/features/playback/store/loudnessBackfillWindow';

/** Subsonic-server loudness-cache row as Rust hands it back. */
type LoudnessCachePayload = {
  integratedLufs: number;
  truePeak: number;
  recommendedGainDb: number;
  targetLufs: number;
  updatedAt: number;
};

/**
 * Coalesce concurrent `analysis_get_loudness_for_track` for one id+mode
 * pair. The `analysis:waveform-updated` listener fires refreshWaveform +
 * refreshLoudness in parallel for every full-track analysis completion;
 * without coalescing, gapless preload + current-track completion can
 * stack two SQLite reads + two state writes.
 */
const loudnessRefreshInflight = new Map<string, Promise<void>>();

/**
 * Fetch the loudness gain for `trackId` from Rust and apply it to the
 * loudness-gain cache + player-store debug fields. When `syncPlayingEngine`
 * is false (default true), the engine is NOT asked to update its
 * replay-gain — used when prefetching neighbour tracks.
 *
 * Coalesces by (trackId, syncEngine, target) so concurrent calls share a
 * single inflight promise.
 */
export async function refreshLoudnessForTrack(
  trackId: string,
  opts?: { syncPlayingEngine?: boolean },
): Promise<void> {
  if (!trackId) return;
  const syncEngine = opts?.syncPlayingEngine !== false;
  const target = useAuthStore.getState().loudnessTargetLufs;
  const inflightKey = `${trackId}|${syncEngine ? 'sync' : 'no-sync'}|${target}`;
  const existing = loudnessRefreshInflight.get(inflightKey);
  if (existing) return existing;
  const job = (async () => { await runRefreshLoudnessForTrack(trackId, syncEngine); })()
    .finally(() => { loudnessRefreshInflight.delete(inflightKey); });
  loudnessRefreshInflight.set(inflightKey, job);
  return job;
}

async function runRefreshLoudnessForTrack(trackId: string, syncEngine: boolean): Promise<void> {
  emitNormalizationDebug('refresh:start', { trackId });
  usePlayerStore.setState({ normalizationDbgSource: 'refresh:start', normalizationDbgTrackId: trackId });
  try {
    const requestedTarget = useAuthStore.getState().loudnessTargetLufs;
    const serverId = getPlaybackIndexKey() || null;
    const loudnessRes = await commands.analysisGetLoudnessForTrack(trackId, requestedTarget, serverId);
    if (loudnessRes.status === 'error') throw new Error(loudnessRes.error);
    // Boundary cast: the generated DTO widens `recommendedGainDb` to `number | null`;
    // downstream relies on the FE type's non-null shape (guarded at runtime by Number.isFinite).
    const row = loudnessRes.data as LoudnessCachePayload | null;
    if (useAuthStore.getState().loudnessTargetLufs !== requestedTarget) {
      emitNormalizationDebug('refresh:stale-target', { trackId, requestedTarget });
      void refreshLoudnessForTrack(trackId, { syncPlayingEngine: syncEngine });
      return;
    }
    if (!row || !Number.isFinite(row.recommendedGainDb)) {
      forgetLoudnessGain(trackId);
      emitNormalizationDebug('refresh:miss', { trackId, row: row ?? null });
      const auth = useAuthStore.getState();
      const attempts = getBackfillAttempts(trackId);
      if (auth.normalizationEngine === 'loudness'
        && !isBackfillInFlight(trackId)
        && attempts < MAX_BACKFILL_ATTEMPTS_PER_TRACK) {
        const live = usePlayerStore.getState();
        if (!isTrackInsideLoudnessBackfillWindow(trackId, live.queueItems, live.queueIndex, live.currentTrack)) {
          emitNormalizationDebug('backfill:skipped-outside-window', {
            trackId,
            queueIndex: live.queueIndex,
            aheadWindow: LOUDNESS_BACKFILL_WINDOW_AHEAD,
          });
          return;
        }
        markBackfillInFlight(trackId, attempts + 1);
        const url = buildStreamUrl(trackId);
        const priority = loudnessBackfillPriorityForTrack(
          trackId,
          live.queueItems,
          live.queueIndex,
          live.currentTrack,
        );
        emitNormalizationDebug('backfill:enqueue', {
          trackId,
          url: redactSubsonicUrlForLog(url),
          attempt: attempts + 1,
          priority,
        });
        void commands.analysisEnqueueSeedFromUrl(trackId, url, null, serverId, priority)
          .then((res) => {
            if (res.status === 'error') throw new Error(res.error);
            emitNormalizationDebug('backfill:queued', { trackId, attempt: attempts + 1 });
          })
          .catch((e) => emitNormalizationDebug('backfill:error', { trackId, error: String(e) }))
          .finally(() => {
            clearBackfillInFlight(trackId);
          });
      } else if (auth.normalizationEngine === 'loudness' && attempts >= MAX_BACKFILL_ATTEMPTS_PER_TRACK) {
        emitNormalizationDebug('backfill:throttled', { trackId, attempts });
      }
      usePlayerStore.setState({
        normalizationDbgSource: 'refresh:miss',
        normalizationDbgTrackId: trackId,
        normalizationDbgCacheGainDb: null,
        normalizationDbgCacheTargetLufs: Number.isFinite(row?.targetLufs as number) ? (row?.targetLufs as number) : null,
        normalizationDbgCacheUpdatedAt: Number.isFinite(row?.updatedAt as number) ? (row?.updatedAt as number) : null,
      });
      return;
    }
    markLoudnessStable(trackId, row.recommendedGainDb);
    resetBackfillAttempts(trackId);
    emitNormalizationDebug('refresh:hit', { trackId, row });
    usePlayerStore.setState({
      normalizationDbgSource: 'refresh:hit',
      normalizationDbgTrackId: trackId,
      normalizationDbgCacheGainDb: row.recommendedGainDb,
      normalizationDbgCacheTargetLufs: Number.isFinite(row.targetLufs) ? row.targetLufs : null,
      normalizationDbgCacheUpdatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null,
    });
    if (syncEngine) {
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }
  } catch {
    forgetLoudnessGain(trackId);
    emitNormalizationDebug('refresh:error', { trackId });
    usePlayerStore.setState({ normalizationDbgSource: 'refresh:error', normalizationDbgTrackId: trackId });
  }
}

/** Test-only: drop pending refresh promises so each spec starts clean. */
export function _resetLoudnessRefreshInflightForTest(): void {
  loudnessRefreshInflight.clear();
}
