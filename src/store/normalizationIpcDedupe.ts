import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from './authStore';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';

/**
 * Two IPC entry points to the Rust normalization pipeline that get hammered
 * by analysis ticks, queue rewrites, and React-StrictMode double mounts —
 * each carries its own time-bounded de-duplicator so the same payload sent
 * within a short window collapses into a single `invoke`.
 *
 *  - `invokeAudioSetNormalizationDeduped` — `audio_set_normalization`
 *    (engine + target + pre-attenuation). 450 ms window.
 *  - `invokeAudioUpdateReplayGainDeduped` — `audio_update_replay_gain`
 *    (per-track gain + peak). 250 ms window. The dedupe key picks up the
 *    LUFS target / pre-trim implicitly so Rust still recomputes when the
 *    user changes the target even if JS happens to forward the same dB.
 */

let lastNormAudioInvokeKey = '';
let lastNormAudioInvokeAtMs = 0;

const NORMALIZATION_DEDUPE_WINDOW_MS = 450;

export function invokeAudioSetNormalizationDeduped(payload: {
  engine: string;
  targetLufs: number;
  preAnalysisAttenuationDb: number;
}): void {
  const key = `${payload.engine}|${payload.targetLufs}|${payload.preAnalysisAttenuationDb}`;
  const now = Date.now();
  if (key === lastNormAudioInvokeKey && now - lastNormAudioInvokeAtMs < NORMALIZATION_DEDUPE_WINDOW_MS) {
    return;
  }
  lastNormAudioInvokeKey = key;
  lastNormAudioInvokeAtMs = now;
  void invoke('audio_set_normalization', payload).catch(() => {});
}

let lastRgInvokeKey = '';
let lastRgInvokeAtMs = 0;

const REPLAY_GAIN_DEDUPE_WINDOW_MS = 250;

export function invokeAudioUpdateReplayGainDeduped(payload: {
  volume: number;
  replayGainDb: number | null;
  replayGainPeak: number | null;
  loudnessGainDb: number | null;
  preGainDb: number;
  fallbackDb: number;
}): void {
  const auth = useAuthStore.getState();
  /** Must vary when LUFS target / pre-trim changes: Rust recomputes in `audio_update_replay_gain` even if JS still sends the same cached dB. */
  const preEff =
    auth.normalizationEngine === 'loudness'
      ? effectiveLoudnessPreAnalysisAttenuationDb(
          auth.loudnessPreAnalysisAttenuationDb,
          auth.loudnessTargetLufs,
        )
      : auth.loudnessPreAnalysisAttenuationDb;
  const normDedupeKey =
    auth.normalizationEngine === 'loudness'
      ? `loudness|tgt=${auth.loudnessTargetLufs}|pre=${preEff.toFixed(2)}`
      : auth.normalizationEngine === 'replaygain'
        ? 'replaygain'
        : 'off';
  const fmt = (v: number | null) => (v == null || !Number.isFinite(v) ? 'null' : v.toFixed(3));
  const key = [
    normDedupeKey,
    payload.volume.toFixed(4),
    fmt(payload.replayGainDb),
    fmt(payload.replayGainPeak),
    fmt(payload.loudnessGainDb),
    payload.preGainDb.toFixed(2),
    payload.fallbackDb.toFixed(2),
  ].join('|');
  const now = Date.now();
  if (key === lastRgInvokeKey && now - lastRgInvokeAtMs < REPLAY_GAIN_DEDUPE_WINDOW_MS) {
    return;
  }
  lastRgInvokeKey = key;
  lastRgInvokeAtMs = now;
  invoke('audio_update_replay_gain', payload).catch(console.error);
}

/** Test-only: clear the cached dedupe state so each spec starts fresh. */
export function _resetNormalizationIpcDedupeForTest(): void {
  lastNormAudioInvokeKey = '';
  lastNormAudioInvokeAtMs = 0;
  lastRgInvokeKey = '';
  lastRgInvokeAtMs = 0;
}
