import { useEffect, useState } from 'react';
import { extractCoverColors } from '@/lib/dom/dynamicColors';

// Module-level cache: artKey → accent color string.
// Survives track changes so same-album songs reuse the extracted color instantly.
const coverAccentCache = new Map<string, string>();

/** Extract a dominant accent color from the current cover art and cache it by
 *  artKey. Cache hits resolve synchronously during render; cache misses fetch
 *  the cover blob, run extractCoverColors, then cache + apply the result. The
 *  previously extracted color stays visible until extraction completes so the
 *  UI doesn't flash to default. */
export function useFsDynamicAccent(artUrl: string, artKey: string): string | null {
  // Cache hit (or no art) is a pure render-time derivation — no synchronous
  // setState in an effect (react-hooks/set-state-in-effect).
  const cached = artKey && artUrl ? coverAccentCache.get(artKey) ?? null : null;
  const [extracted, setExtracted] = useState<string | null>(null);

  useEffect(() => {
    if (!artKey || !artUrl || coverAccentCache.has(artKey)) return;
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
          setExtracted(colors.accent);
        }
      } catch { /* ignore */ } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artKey]);

  if (!artKey || !artUrl) return null;
  return cached ?? extracted;
}
