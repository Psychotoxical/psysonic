import { useEffect, useState } from 'react';
import { artistCoverRef } from './ref';
import { coverDiskUrl } from './diskSrcCache';
import { coverCacheEnsure } from '../api/coverCache';
import { useThemeStore } from '../store/themeStore';

/**
 * Resolve an external fanart.tv artist image to a webview-loadable asset URL for
 * the given surface (`fanart` = 16:9 background, `banner` = wide header strip).
 * Returns `''` when the External Artwork Scraper toggle is off, while pending,
 * or when no image of that kind is available.
 *
 * Deliberately bypasses the shared cover peek / disk-src cache: each surface has
 * its own `{tier}-{surface}.webp`, and `cover_cache_ensure` already peeks that
 * surface first and returns the cached path on a hit. All MBID resolution +
 * caching lives Rust-side; this hook just kicks the ensure and shows the path it
 * hands back. The cache is shared across callers, so e.g. the artist-detail
 * header and the fullscreen player warm each other's images.
 */
function useArtistExternalImage(
  artistId: string | null | undefined,
  surface: 'fanart' | 'banner',
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
    void coverCacheEnsure(ref, 2000, 'high', { surfaceKind: surface, artistName, albumTitle })
      .then((res) => {
        if (!cancelled) setSrc(res.hit && res.path ? coverDiskUrl(res.path) : '');
      })
      .catch(() => {
        if (!cancelled) setSrc('');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, artistId, surface, artistName, albumTitle]);

  return src;
}

/** fanart.tv 16:9 `artistbackground` (fullscreen player background). */
export function useArtistFanart(
  artistId: string | null | undefined,
  ctx?: { artistName?: string; albumTitle?: string },
): string {
  return useArtistExternalImage(artistId, 'fanart', ctx);
}

/** fanart.tv wide `musicbanner` (artist-detail header strip). */
export function useArtistBanner(
  artistId: string | null | undefined,
  ctx?: { artistName?: string; albumTitle?: string },
): string {
  return useArtistExternalImage(artistId, 'banner', ctx);
}
