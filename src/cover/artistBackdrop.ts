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

/** A backdrop image source a surface can draw from, in user-configurable order. */
export type BackdropSource = 'banner' | 'fanart' | 'navidrome';

/** One entry in a surface's ordered source list: which source, and whether it
 *  participates. Array order is the resolution priority. */
export interface BackdropSourcePref {
  source: BackdropSource;
  enabled: boolean;
}

/** A resolved candidate for {@link resolveBackdrop}. `centered` marks the wide
 *  banner strip (kept centered); everything else raises the focal point. */
export interface BackdropCandidate {
  src: string;
  /** True while the source is still fetching — hold rather than flash a lower one. */
  pending?: boolean;
  /** Banner = true (centered); portrait-ish fanart / artist covers = false. */
  centered?: boolean;
}

/**
 * Walk an ordered candidate list and pick the backdrop:
 *   - a resolved `src` wins immediately (its `centered` flag sets the framing);
 *   - a still-`pending` candidate holds an empty url rather than flashing a
 *     lower-priority surface beneath it;
 *   - a confirmed miss (`src === ''`, not pending) steps to the next candidate.
 * When nothing resolves the url is '' with the portrait focal default — framing
 * only goes centered when a *banner* actually wins.
 */
export function resolveBackdrop(candidates: BackdropCandidate[]): ArtistBackdrop {
  for (const c of candidates) {
    if (c.src) return { url: c.src, position: c.centered ? undefined : 'center 30%' };
    if (c.pending) return { url: '', position: 'center 30%' };
  }
  return { url: '', position: 'center 30%' };
}

/** Per-source resolved values handed to {@link backdropFromConfig}. A source the
 *  caller cannot offer (e.g. no banner on the fullscreen player) is omitted. */
export interface BackdropSourceValues {
  banner?: ArtistImage;
  fanart?: ArtistImage;
  /** Navidrome artist cover — a plain url, never pending. */
  navidrome?: string;
}

/**
 * Build the candidate list from a surface's ordered+filtered source prefs and
 * the resolved values, then resolve it. Disabled prefs and sources the caller
 * did not supply are skipped, so the same helper drives every surface — the
 * fullscreen player simply omits `banner` from both the prefs and the values.
 *
 * Shared by the mainstage hero, the artist-detail header and the fullscreen
 * player so all three resolve and frame their backdrop identically.
 */
export function backdropFromConfig(
  sources: BackdropSourcePref[],
  values: BackdropSourceValues,
): ArtistBackdrop {
  const candidates: BackdropCandidate[] = [];
  for (const { source, enabled } of sources) {
    if (!enabled) continue;
    if (source === 'banner' && values.banner) {
      candidates.push({ src: values.banner.src, pending: values.banner.pending, centered: true });
    } else if (source === 'fanart' && values.fanart) {
      candidates.push({ src: values.fanart.src, pending: values.fanart.pending, centered: false });
    } else if (source === 'navidrome' && values.navidrome !== undefined) {
      candidates.push({ src: values.navidrome, pending: false, centered: false });
    }
  }
  return resolveBackdrop(candidates);
}
