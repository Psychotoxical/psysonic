import type { CoverArtId } from './types';

/** Extra Subsonic ids to probe on disk when the resolved id folder is empty. */
export type DiskCoverIdHints = {
  albumId?: string | null;
  songId?: string | null;
  rawCoverArt?: string | null;
  /** Album grid / catalog row id — often matches on-disk cache layout. */
  albumCoverArt?: string | null;
};

/** Order: resolved id, raw coverArt, album row coverArt, albumId, song id. */
export function diskCoverArtIdCandidates(
  primaryId: CoverArtId,
  hints?: DiskCoverIdHints,
): CoverArtId[] {
  const out: CoverArtId[] = [];
  const add = (v?: string | null) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t && !out.includes(t)) out.push(t);
  };
  add(primaryId);
  add(hints?.rawCoverArt);
  add(hints?.albumCoverArt);
  add(hints?.albumId);
  add(hints?.songId);
  return out;
}
