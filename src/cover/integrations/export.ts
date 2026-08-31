import { albumCoverRef } from '../ref';
import { ensureCoverTierJs } from '../resolveJs';
import { coverServerScopeForServerId } from '../serverScope';
import { resolveCoverDisplayTier } from '../tiers';
import type { CoverArtRef } from '../types';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

/**
 * Cover ref for canvas exports — built from the same three inputs an album card
 * resolves its ref from: album id, the server's cover id, and the owner server
 * scope. Sharing that shape is what lets an export reuse the disk slot the grid
 * already filled instead of opening a second one.
 *
 * Passing `coverArt` as *both* ids (the old `coverArtRef(album.coverArt)`
 * shortcut) makes `resolveAlbumCoverEntry` take its bare-album-id branch and
 * rewrite an already prefixed Navidrome id into `al-al-<id>_0` — an id no
 * server resolves, so every tile fell back to an empty panel. An album with no
 * id cannot reach the card's slot at all, so it yields `null` rather than
 * falling back to `coverArt` and reintroducing that rewrite.
 *
 * Per-disc artwork is deliberately not requested: `resolveDistinctDiscCoversForAlbum`
 * is keyed per server here but written per server in `AlbumDetail`, so an unscoped
 * ask misses today, and asking for it also suppresses the `al-<id>_0` fetch id that
 * an album without a server-side `coverArt` needs. Card and export therefore both
 * leave it at its default; the two have to change together, not one of them here.
 */
export function albumExportCoverRef(
  album: Pick<SubsonicAlbum, 'id' | 'coverArt' | 'serverId'>,
): CoverArtRef | null {
  const albumId = album.id?.trim();
  if (!albumId) return null;
  return albumCoverRef(albumId, album.coverArt, coverServerScopeForServerId(album.serverId));
}

/** Canvas/export helper — resolves tier from CSS px then returns a Blob. */
export async function loadCoverBlobForExport(
  ref: CoverArtRef,
  displayCssPx: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'sparse' });
  return ensureCoverTierJs(ref, tier, signal);
}
