import { invoke } from '@tauri-apps/api/core';
import { coerceWaveformBins } from '../utils/waveform/waveformParse';
import { usePlayerStore } from './playerStore';
import { getWaveformRefreshGen } from './waveformRefreshGen';

/** Subsonic-server waveform-cache row as Rust hands it back. */
export type WaveformCachePayload = {
  /** May be `number[]` or `Uint8Array` depending on Tauri IPC / serde path. */
  bins: number[] | Uint8Array;
  binCount: number;
  isPartial: boolean;
  knownUntilSec: number;
  durationSec: number;
  updatedAt: number;
};

/**
 * Fetch the cached waveform row for `trackId` from Rust and apply its bins
 * to the player store — but only if (a) the refresh generation snapshot
 * still matches (no newer invalidation has fired meanwhile) and (b) the
 * track is still the current one. Best-effort: any failure leaves the
 * seekbar with the placeholder waveform.
 */
export async function refreshWaveformForTrack(trackId: string): Promise<void> {
  if (!trackId) return;
  const gen = getWaveformRefreshGen(trackId);
  try {
    const row = await invoke<WaveformCachePayload | null>('analysis_get_waveform_for_track', { trackId });
    if (getWaveformRefreshGen(trackId) !== gen) return;
    // Never apply bins for a non-current track (e.g. gapless byte-preload fetches the neighbour).
    if (usePlayerStore.getState().currentTrack?.id !== trackId) return;
    const bins = row ? coerceWaveformBins(row.bins) : null;
    if (!bins || bins.length === 0) {
      usePlayerStore.setState({
        waveformBins: null,
      });
      return;
    }
    usePlayerStore.setState({
      waveformBins: bins,
    });
  } catch {
    // best-effort; seekbar falls back to placeholder waveform
  }
}
