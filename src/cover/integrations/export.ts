import { albumCoverRef } from '../ref';
import { ensureCoverTierJs } from '../resolveJs';
import { coverServerScopeForServerId } from '../serverScope';
import { resolveCoverDisplayTier } from '../tiers';
import type { CoverArtRef } from '../types';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

/**
 * Cover ref for canvas exports — built the same way the album cards build
 * theirs (album id + the server's `coverArt` id), so an export reuses the cache
 * slot the grid already filled instead of opening a second one.
 *
 * Passing `coverArt` as *both* ids (the old `coverArtRef(album.coverArt)`
 * shortcut) makes `resolveAlbumCoverEntry` take its bare-album-id branch and
 * rewrite an already-prefixed Navidrome id into `al-al-<id>_0` — an id no
 * server resolves, so every tile fell back to an empty panel.
 */
export function albumExportCoverRef(
  album: Pick<SubsonicAlbum, 'id' | 'coverArt' | 'serverId'>,
): CoverArtRef | null {
  const albumId = album.id?.trim();
  const coverArt = album.coverArt?.trim();
  const entityId = albumId || coverArt;
  if (!entityId) return null;
  return albumCoverRef(entityId, coverArt, coverServerScopeForServerId(album.serverId));
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
