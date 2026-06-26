import { useEffect, useState } from 'react';
import { artistCoverRef } from './ref';
import { coverDiskUrl } from './diskSrcCache';
import { coverCacheEnsure } from '../api/coverCache';
import { useThemeStore } from '../store/themeStore';

/**
 * Resolve an external fanart.tv artist image to a webview-loadable asset URL for
 * the given surface (`fanart` = 16:9 background, `banner` = wide header strip).
 *
 * Returns `{ src, pending }`: `src` is `''` while resolving, when the toggle is
 * off, or when no image of that kind exists; `pending` is `true` only while the
 * ensure is in flight. `pending` lets callers tell "still fetching" (hold back
 * a fallback) apart from "resolved, no image" (fall back now).
 *
 * Deliberately bypasses the shared cover peek / disk-src cache: each surface has
 * its own `{tier}-{surface}.webp`, and `cover_cache_ensure` already peeks that
 * surface first and returns the cached path on a hit. All MBID resolution +
 * caching lives Rust-side; this hook just kicks the ensure and shows the path it
 * hands back. The cache is shared across callers, so e.g. the artist-detail
 * header and the fullscreen player warm each other's images.
 */
type ArtistImageCtx = { artistName?: string; albumTitle?: string };

export type ArtistImage = { src: string; pending: boolean };

function useArtistExternalImage(
  artistId: string | null | undefined,
  surface: 'fanart' | 'banner',
  ctx?: ArtistImageCtx,
): ArtistImage {
  const enabled = useThemeStore((s) => s.externalArtworkEnabled);
  const [image, setImage] = useState<ArtistImage>({ src: '', pending: false });
  const artistName = ctx?.artistName;
  const albumTitle = ctx?.albumTitle;

  // Reset synchronously when the target artist/surface changes, so a consumer
  // never reads the *previous* artist's resolved image for the one render
  // between the change and the effect below. Without this the hero froze (or
  // cached into per-album memory) a neighbouring slide's banner. This is the
  // React "adjust state on prop change" pattern — the set-state-during-render
  // restarts the render, so `image` is already cleared this pass.
  const resetKey = `${enabled ? '1' : '0'}|${artistId ?? ''}|${surface}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setImage({ src: '', pending: Boolean(enabled && artistId) });
  }

  useEffect(() => {
    if (!enabled || !artistId) {
      // Nothing will resolve — not pending, so callers fall back immediately.
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setImage({ src: '', pending: false });
      return;
    }
    // Reset + mark pending so a previous artist's image never lingers and
    // callers hold their fallback until this resolves.
    setImage({ src: '', pending: true });
    let cancelled = false;
    const ref = artistCoverRef(artistId);
    void coverCacheEnsure(ref, 2000, 'high', { surfaceKind: surface, artistName, albumTitle })
      .then((res) => {
        if (!cancelled)
          setImage({ src: res.hit && res.path ? coverDiskUrl(res.path) : '', pending: false });
      })
      .catch(() => {
        if (!cancelled) setImage({ src: '', pending: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, artistId, surface, artistName, albumTitle]);

  return image;
}

/** fanart.tv 16:9 `artistbackground` (fullscreen player background). */
export function useArtistFanart(
  artistId: string | null | undefined,
  ctx?: ArtistImageCtx,
): ArtistImage {
  return useArtistExternalImage(artistId, 'fanart', ctx);
}

/** fanart.tv wide `musicbanner` (artist-detail header strip). */
export function useArtistBanner(
  artistId: string | null | undefined,
  ctx?: ArtistImageCtx,
): ArtistImage {
  return useArtistExternalImage(artistId, 'banner', ctx);
}
