import { useEffect, useRef, useState } from 'react';
import { extractCoverColors } from '@/lib/dom/dynamicColors';

// Module-level cache: artKey → accent color string.
// Survives track changes so same-album songs reuse the extracted color instantly.
const coverAccentCache = new Map<string, string>();

/** Extract a dominant accent color from the current cover art and cache it by
 *  artKey. Cache hits resolve synchronously during render; a miss fetches the
 *  cover blob, runs extractCoverColors, writes the cache and forces a re-render.
 *  While a new album's color is in flight the LAST shown color stays visible
 *  (via a ref) so the accent never flashes to default. */
export function useFsDynamicAccent(artUrl: string, artKey: string): string | null {
  // The module cache is the source of truth (the async callback writes it, so a
  // completed extraction shows up here on the next render). `bump` only forces
  // that re-render — no synchronous setState in the effect body.
  const cached = artKey && artUrl ? coverAccentCache.get(artKey) ?? null : null;
  const [, bump] = useState(0);
  const lastShown = useRef<string | null>(null);

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
          bump(n => n + 1);
        }
      } catch { /* ignore */ } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => { cancelled = true; };
    // artUrl is a dep too: usePlaybackCoverArt yields the cacheKey synchronously
    // but the src asynchronously, so keying only on artKey would fire this effect
    // once with an empty artUrl and never retry. The has(artKey) guard keeps a
    // later src rotation from re-extracting an already-cached cover.
  }, [artKey, artUrl]);

  if (!artKey || !artUrl) {
    lastShown.current = null;
    return null;
  }
  // Cached hit/resolved wins; otherwise hold the last shown color for THIS
  // session (not a stale one keyed to some earlier album) until extraction lands.
  const value = cached ?? lastShown.current;
  if (cached) lastShown.current = cached;
  return value;
}
