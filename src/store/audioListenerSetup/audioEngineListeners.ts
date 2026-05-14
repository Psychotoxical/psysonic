import { listen } from '@tauri-apps/api/event';
import { streamUrlTrackId } from '../../utils/resolvePlaybackUrl';
import { normalizationAlmostEqual } from '../../utils/normalizationCompare';
import { normalizeAnalysisTrackId } from '../../utils/queueIdentity';
import {
  handleAudioEnded,
  handleAudioError,
  handleAudioPlaying,
  handleAudioProgress,
  handleAudioTrackSwitched,
  type NormalizationStatePayload,
} from '../audioEventHandlers';
import {
  getCachedLoudnessGain,
  hasStableLoudness,
  setCachedLoudnessGain,
} from '../loudnessGainCache';
import { refreshLoudnessForTrack } from '../loudnessRefresh';
import { emitNormalizationDebug } from '../normalizationDebug';
import {
  NORMALIZATION_UI_THROTTLE_MS,
  getLastNormalizationUiUpdateAtMs,
  markNormalizationUiUpdate,
} from '../playbackThrottles';
import { usePlayerStore } from '../playerStore';
import { refreshWaveformForTrack } from '../waveformRefresh';
import { bumpWaveformRefreshGen } from '../waveformRefreshGen';

/**
 * Tauri event listeners for the Rust audio engine + analysis pipeline. Returns
 * a cleanup function that unlistens every registered listener.
 */
export function setupAudioEngineListeners(): () => void {
  // Dev-only: warn when audio:progress events arrive faster than 10/s.
  // This would indicate the Rust emit interval was accidentally lowered.
  let _devEventCount = 0;
  let _devWindowStart = 0;

  const pending = [
    listen<number>('audio:playing', ({ payload }) => handleAudioPlaying(payload)),
    listen<{ current_time: number; duration: number }>('audio:progress', ({ payload }) => {
      if (import.meta.env.DEV) {
        _devEventCount++;
        const now = Date.now();
        if (_devWindowStart === 0) _devWindowStart = now;
        if (now - _devWindowStart >= 1000) {
          if (_devEventCount > 10) {
            console.warn(`[psysonic] audio:progress: ${_devEventCount} events/s (threshold: 10) — check Rust emit interval`);
          }
          _devEventCount = 0;
          _devWindowStart = now;
        }
      }
      handleAudioProgress(payload.current_time, payload.duration);
    }),
    listen<void>('audio:ended', () => handleAudioEnded()),
    listen<string>('audio:error', ({ payload }) => handleAudioError(payload)),
    listen<number>('audio:track_switched', ({ payload }) => handleAudioTrackSwitched(payload)),
    listen<{ trackId?: string | null; gainDb: number; targetLufs: number; isPartial: boolean }>('analysis:loudness-partial', ({ payload }) => {
      const current = usePlayerStore.getState().currentTrack;
      if (!current || !payload) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (payloadTrackId && payloadTrackId !== current.id) return;
      if (!Number.isFinite(payload.gainDb)) return;
      if (hasStableLoudness(current.id)) return;
      // Skip when the cached gain is already within ~0.05 dB of the new payload —
      // float jitter from the partial-loudness heuristic would otherwise re-trigger
      // updateReplayGainForCurrentTrack → audio_update_replay_gain → backend echo
      // every PARTIAL_LOUDNESS_EMIT_INTERVAL_MS even when nothing audibly changed.
      const existing = getCachedLoudnessGain(current.id);
      if (Number.isFinite(existing) && Math.abs(existing! - payload.gainDb) < 0.05) return;
      setCachedLoudnessGain(current.id, payload.gainDb);
      emitNormalizationDebug('partial-loudness:apply', {
        trackId: current.id,
        gainDb: payload.gainDb,
        targetLufs: payload.targetLufs,
      });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }),
    listen<{ trackId: string; isPartial: boolean }>('analysis:waveform-updated', ({ payload }) => {
      if (!payload?.trackId) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (!payloadTrackId) return;
      const currentRaw = usePlayerStore.getState().currentTrack?.id;
      const currentId = currentRaw ? normalizeAnalysisTrackId(currentRaw) : null;
      if (currentId && payloadTrackId === currentId) {
        bumpWaveformRefreshGen(currentRaw!);
        void refreshWaveformForTrack(currentRaw!);
        void refreshLoudnessForTrack(currentId);
        emitNormalizationDebug('backfill:applied', { trackId: currentId });
        return;
      }
      // Backfill finished for another id (e.g. next in queue): refresh loudness cache only
      // so the cached gain is ready before `audio_play` / gapless chain.
      void refreshLoudnessForTrack(payloadTrackId, { syncPlayingEngine: false });
      emitNormalizationDebug('backfill:applied', { trackId: payloadTrackId });
    }),
    listen<NormalizationStatePayload>('audio:normalization-state', ({ payload }) => {
      if (!payload) return;
      const engine =
        payload.engine === 'loudness' || payload.engine === 'replaygain'
          ? payload.engine
          : 'off';
      const nowDb = Number.isFinite(payload.currentGainDb as number) ? (payload.currentGainDb as number) : null;
      const targetLufs = Number.isFinite(payload.targetLufs) ? payload.targetLufs : null;
      const prev = usePlayerStore.getState();
      // Avoid UI flicker from noisy duplicate emits and transient nulls.
      if (
        engine === prev.normalizationEngineLive
        && normalizationAlmostEqual(nowDb, prev.normalizationNowDb)
        && normalizationAlmostEqual(targetLufs, prev.normalizationTargetLufs, 0.02)
      ) {
        return;
      }
      if (engine === 'loudness' && nowDb == null && prev.normalizationNowDb != null) {
        return;
      }
      const nowMs = Date.now();
      const isFirstNumericGain =
        engine === 'loudness'
        && nowDb != null
        && prev.normalizationNowDb == null;
      if (
        !isFirstNumericGain
        && nowMs - getLastNormalizationUiUpdateAtMs() < NORMALIZATION_UI_THROTTLE_MS
        && engine === prev.normalizationEngineLive
      ) {
        return;
      }
      markNormalizationUiUpdate(nowMs);
      emitNormalizationDebug('event:audio:normalization-state', {
        trackId: usePlayerStore.getState().currentTrack?.id ?? null,
        payload,
      });
      usePlayerStore.setState({
        normalizationEngineLive: engine,
        normalizationNowDb: nowDb,
        normalizationTargetLufs: targetLufs,
        normalizationDbgSource: 'event:audio:normalization-state',
        normalizationDbgLastEventAt: Date.now(),
      });
    }),
    listen<string>('audio:preload-ready', ({ payload }) => {
      const tid = streamUrlTrackId(payload);
      if (import.meta.env.DEV) {
        console.info('[psysonic][preload-ready]', {
          payload,
          parsedTrackId: tid,
          prevEnginePreloadedTrackId: usePlayerStore.getState().enginePreloadedTrackId,
        });
      }
      if (tid) usePlayerStore.setState({ enginePreloadedTrackId: tid });
      else if (import.meta.env.DEV) {
        console.warn('[psysonic][preload-ready] could not parse track id from payload URL');
      }
    }),
  ];

  return () => {
    pending.forEach(p => p.then(unlisten => unlisten()));
  };
}
