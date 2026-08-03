import { commands } from '@/generated/bindings';
import { coerceWaveformBins } from '@/lib/waveform/waveformParse';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { getWaveformRefreshGen } from '@/features/playback/store/waveformRefreshGen';
import {
  analysisTrackRef,
  analysisTrackRefForTrack,
  analysisTrackRefKey,
  type AnalysisTrackRef,
} from '@/features/playback/store/analysisTrackRef';

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

const waveformRefreshInflight = new Map<string, Promise<void>>();

/**
 * Fetch the cached waveform row for `trackId` from Rust and apply its bins
 * to the player store — but only if (a) the refresh generation snapshot
 * still matches (no newer invalidation has fired meanwhile) and (b) the
 * track is still the current one. Best-effort: any failure leaves the
 * seekbar with the placeholder waveform.
 */
/**
 * Fetch a track's cached waveform bins **without touching the player store** —
 * used by the silence-aware crossfade to inspect the *next* track's leading
 * silence while a different track is still playing (writing `waveformBins` here
 * would replace the current track's seekbar). Returns `null` on a cold miss /
 * any failure so callers degrade to no-trim.
 */
export async function fetchWaveformBins(
  inputRef: AnalysisTrackRef,
): Promise<number[] | null> {
  const trackId = inputRef.trackId;
  if (!trackId || !inputRef.serverIndexKey) return null;
  try {
    const ref = analysisTrackRef(trackId, inputRef.serverIndexKey);
    const res = await commands.analysisGetWaveformForTrack(trackId, ref.serverIndexKey);
    if (res.status === 'error') throw new Error(res.error);
    const row = res.data;
    const bins = row ? coerceWaveformBins(row.bins) : null;
    return bins && bins.length > 0 ? bins : null;
  } catch {
    return null;
  }
}

export async function refreshWaveformForTrack(inputRef: AnalysisTrackRef): Promise<void> {
  const trackId = inputRef.trackId;
  if (!trackId || !inputRef.serverIndexKey) return;
  const ref = analysisTrackRef(trackId, inputRef.serverIndexKey);
  const gen = getWaveformRefreshGen(ref);
  const inflightKey = `${analysisTrackRefKey(ref)}|${gen}`;
  const existing = waveformRefreshInflight.get(inflightKey);
  if (existing) return existing;
  const job = runRefreshWaveformForTrack(ref, gen)
    .finally(() => { waveformRefreshInflight.delete(inflightKey); });
  waveformRefreshInflight.set(inflightKey, job);
  return job;
}

async function runRefreshWaveformForTrack(ref: AnalysisTrackRef, gen: number): Promise<void> {
  const { trackId } = ref;
  try {
    const res = await commands.analysisGetWaveformForTrack(trackId, ref.serverIndexKey);
    if (res.status === 'error') throw new Error(res.error);
    const row = res.data;
    if (getWaveformRefreshGen(ref) !== gen) return;
    // Never apply bins for a non-current track (e.g. gapless byte-preload fetches the neighbour).
    const state = usePlayerStore.getState();
    if (!state.currentTrack) return;
    const currentRef = analysisTrackRefForTrack(
      state.currentTrack,
      state.queueItems?.[state.queueIndex],
    );
    if (analysisTrackRefKey(currentRef) !== analysisTrackRefKey(ref)) return;
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

/** Test-only: drop pending refresh promises so each spec starts clean. */
export function _resetWaveformRefreshInflightForTest(): void {
  waveformRefreshInflight.clear();
}
