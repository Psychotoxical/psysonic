import { commands } from '@/generated/bindings';
import { coerceWaveformBins } from '@/lib/waveform/waveformParse';
import { getPlaybackIndexKey } from '@/features/playback/utils/playback/playbackServer';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { getWaveformRefreshGen } from '@/features/playback/store/waveformRefreshGen';

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
/**
 * Fetch a track's cached waveform bins **without touching the player store** —
 * used by the silence-aware crossfade to inspect the *next* track's leading
 * silence while a different track is still playing (writing `waveformBins` here
 * would replace the current track's seekbar). Returns `null` on a cold miss /
 * any failure so callers degrade to no-trim.
 */
export async function fetchWaveformBins(
  trackId: string,
  serverId?: string | null,
): Promise<number[] | null> {
  if (!trackId) return null;
  try {
    const res = await commands.analysisGetWaveformForTrack(trackId, serverId ?? getPlaybackIndexKey() ?? null);
    if (res.status === 'error') throw new Error(res.error);
    const row = res.data;
    const bins = row ? coerceWaveformBins(row.bins) : null;
    return bins && bins.length > 0 ? bins : null;
  } catch {
    return null;
  }
}

export async function refreshWaveformForTrack(trackId: string): Promise<void> {
  if (!trackId) return;
  const gen = getWaveformRefreshGen(trackId);
  try {
    const res = await commands.analysisGetWaveformForTrack(trackId, getPlaybackIndexKey() || null);
    if (res.status === 'error') throw new Error(res.error);
    const row = res.data;
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
