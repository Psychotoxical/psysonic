/**
 * Parse the waveform-bin payload Rust hands us. Two on-disk shapes survive:
 * the v4 dual-curve (500 bytes peak + 500 bytes mean-abs = 1000 total) and
 * the legacy single curve (500 bytes, treated as both peak and mean).
 *
 * `bins` may arrive as a real `number[]`, a `Uint8Array`, or any other
 * `ArrayLike<number>` depending on Tauri's serialization path — coerce to a
 * plain `number[]` clamped to a single byte, or return null when the shape
 * doesn't match an accepted curve length.
 */
export function waveformBlobLenOk(len: number): boolean {
  return len === 500 || len === 1000;
}

export function coerceWaveformBins(bins: unknown): number[] | null {
  if (bins == null) return null;
  let raw: number[] | null = null;
  if (Array.isArray(bins)) {
    if (bins.length === 0) return null;
    raw = bins.map(x => Number(x) & 255);
  } else if (bins instanceof Uint8Array) {
    if (bins.length === 0) return null;
    raw = Array.from(bins);
  } else if (typeof bins === 'object' && 'length' in bins && typeof (bins as { length: unknown }).length === 'number') {
    const len = (bins as { length: number }).length;
    if (len === 0) return null;
    try {
      raw = Array.from(bins as ArrayLike<number>).map(x => Number(x) & 255);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!waveformBlobLenOk(raw.length)) return null;
  return raw;
}
