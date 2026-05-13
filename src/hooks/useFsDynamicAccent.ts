import { useEffect, useState } from 'react';
import { extractCoverColors } from '../utils/dynamicColors';

// Module-level cache: artKey → accent color string.
// Survives track changes so same-album songs reuse the extracted color instantly.
const coverAccentCache = new Map<string, string>();

/** Extract a dominant accent color from the current cover art and cache it by
 *  artKey. Cache hits return instantly; cache misses fetch the cover blob,
 *  run extractCoverColors, then cache + apply the result. Keeps the previous
 *  color visible until extraction completes so the UI doesn't flash to default. */
export function useFsDynamicAccent(artUrl: string, artKey: string): string | null {
  const [dynamicAccent, setDynamicAccent] = useState<string | null>(null);

  useEffect(() => {
    if (!artKey || !artUrl) { setDynamicAccent(null); return; }
    const cached = coverAccentCache.get(artKey);
    if (cached) { setDynamicAccent(cached); return; }
    let cancelled = false;
    let blobUrl = '';
    (async () => {
      try {
        const resp = await fetch(artUrl);
        if (cancelled) return;
        const blob = await resp.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        const colors = await extractCoverColors(blobUrl);
        if (cancelled) return;
        if (colors.accent) {
          coverAccentCache.set(artKey, colors.accent);
          setDynamicAccent(colors.accent);
        }
      } catch { /* ignore */ } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artKey]);

  return dynamicAccent;
}
