import type { ArtistImage } from './useArtistFanart';

export interface ArtistBackdrop {
  /** URL to render, or '' while a higher-priority surface is still resolving. */
  url: string;
  /**
   * `object-position` / `background-position` override; `undefined` keeps the
   * shared centered default.
   */
  position?: string;
}

/**
 * Shared artist-header backdrop priority: fanart banner → 16:9 fanart → the
 * caller's fallback (the Navidrome artist cover). While a stage is still
 * resolving (`pending`) we hold an empty url rather than flash a lower-priority
 * surface; on a confirmed miss (`src === ''`, not pending) we step to the next
 * stage. With the external-artwork toggle off both surfaces report a non-pending
 * miss, so the chain falls straight through to the fallback.
 *
 * The banner is a purpose-built wide strip → keep it centered. The fanart /
 * fallback images are portrait-ish → raise the focal point so heads stay in
 * frame on wide viewports.
 *
 * Used by both the artist-detail header and the mainstage hero so the two stay
 * identical by construction.
 */
export function pickArtistBackdrop(
  banner: ArtistImage,
  fanart: ArtistImage,
  fallbackUrl: string,
): ArtistBackdrop {
  const url =
    banner.src || (banner.pending ? '' : fanart.src || (fanart.pending ? '' : fallbackUrl));
  const position = banner.src ? undefined : 'center 30%';
  return { url, position };
}
