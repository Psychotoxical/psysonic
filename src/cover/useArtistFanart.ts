import { useEffect, useState } from 'react';
import { artistCoverRef } from './ref';
import { coverDiskUrl } from './diskSrcCache';
import { coverCacheEnsure } from '../api/coverCache';
import { useThemeStore } from '../store/themeStore';

/**
 * Resolve a fanart.tv 16:9 artist background to a webview-loadable asset URL.
 * Returns `''` when the External Artwork Scraper toggle is off, while pending,
 * or when no fanart is available.
 *
 * Deliberately bypasses the shared cover peek / disk-src cache: the
 * `{tier}-fanart.webp` surface has its own ensure (§28), and `cover_cache_ensure`
 * already peeks fanart-first and returns the cached path on a hit. All MBID
 * resolution + caching lives Rust-side; this hook just kicks the ensure and
 * shows the path it hands back.
 */
export function useArtistFanart(
  artistId: string | null | undefined,
  ctx?: { artistName?: string; albumTitle?: string },
): string {
  const enabled = useThemeStore((s) => s.externalArtworkEnabled);
  const [src, setSrc] = useState('');
  const artistName = ctx?.artistName;
  const albumTitle = ctx?.albumTitle;

  useEffect(() => {
    if (!enabled || !artistId) {
      setSrc('');
      return;
    }
    let cancelled = false;
    const ref = artistCoverRef(artistId);
    void coverCacheEnsure(ref, 2000, 'high', { surfaceKind: 'fanart', artistName, albumTitle })
      .then((res) => {
        if (!cancelled) setSrc(res.hit && res.path ? coverDiskUrl(res.path) : '');
      })
      .catch(() => {
        if (!cancelled) setSrc('');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, artistId, artistName, albumTitle]);

  return src;
}
