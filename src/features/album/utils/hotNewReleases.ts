import { getAlbumListForServer } from '@/lib/api/subsonicLibrary';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  libraryResolveAlbumOverlay,
  type LibraryScopePair,
} from '@/lib/api/library/scopeReads';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

export const HOT_NEW_RELEASE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const HOT_NEW_RELEASE_SAMPLE_SIZE = 24;
const HOT_NEW_RELEASE_CONCURRENCY = 4;

function createdAtMs(album: SubsonicAlbum): number | null {
  const value = Date.parse(album.created ?? '');
  return Number.isFinite(value) ? value : null;
}

function albumVersionFromTags(tags: unknown): string | null {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return null;
  const albumversion = (tags as Record<string, unknown>).albumversion;
  const values = Array.isArray(albumversion) ? albumversion : [albumversion];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const version = value.trim();
    if (version) return version;
  }
  return null;
}

export interface ResolvedHotNewRelease {
  album: SubsonicAlbum;
  group: number;
  representativeServerId?: string | null;
  representativeId?: string | null;
}

function overlayCreatedAt(local: SubsonicAlbum, hot: SubsonicAlbum): SubsonicAlbum {
  const localCreated = createdAtMs(local) ?? -Infinity;
  const hotCreated = createdAtMs(hot) ?? -Infinity;
  return hotCreated > localCreated ? { ...local, created: hot.created } : local;
}

export function mergeHotNewReleases(
  local: SubsonicAlbum[],
  hot: ResolvedHotNewRelease[],
): SubsonicAlbum[] {
  const merged = new Map<string, SubsonicAlbum>();
  const localEntryByOwner = new Map<string, string>();
  for (const album of local) {
    const entryKey = `local:${ownedEntityKey(album)}`;
    merged.set(entryKey, album);
    localEntryByOwner.set(ownedEntityKey(album), entryKey);
  }
  const orderedHot = [...hot].sort((left, right) => (
    (createdAtMs(right.album) ?? -Infinity) - (createdAtMs(left.album) ?? -Infinity)
    || ownedEntityKey(left.album).localeCompare(ownedEntityKey(right.album))
  ));
  for (const resolved of orderedHot) {
    const representativeKey = resolved.representativeServerId && resolved.representativeId
      ? ownedEntityKey({ id: resolved.representativeId, serverId: resolved.representativeServerId })
      : null;
    const localEntry = representativeKey ? localEntryByOwner.get(representativeKey) : undefined;
    const entryKey = localEntry ?? `hot:${resolved.group}`;
    const prior = merged.get(entryKey);
    if (!prior) {
      merged.set(entryKey, representativeKey ? {
        ...resolved.album,
        serverId: resolved.representativeServerId ?? resolved.album.serverId,
        id: resolved.representativeId ?? resolved.album.id,
      } : resolved.album);
    } else if (localEntry) {
      merged.set(entryKey, overlayCreatedAt(prior, resolved.album));
    }
  }
  return [...merged.values()].sort((left, right) => (
    (createdAtMs(right) ?? -Infinity) - (createdAtMs(left) ?? -Infinity)
  ));
}

/** Bounded page-only freshness overlay. It never writes incomplete album summaries into SQLite. */
export async function fetchHotNewReleases(
  scopes: LibraryScopePair[],
  now = Date.now(),
): Promise<ResolvedHotNewRelease[]> {
  const cutoff = now - HOT_NEW_RELEASE_WINDOW_MS;
  const results: SubsonicAlbum[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const scope = scopes[next++];
      if (!scope) return;
      try {
        const albums = await getAlbumListForServer(
          scope.serverId,
          'newest',
          HOT_NEW_RELEASE_SAMPLE_SIZE,
          0,
          { musicFolderId: scope.libraryId },
          8000,
        );
        results.push(...albums
          .filter(album => (createdAtMs(album) ?? -Infinity) >= cutoff)
          .map(album => ({ ...album, serverId: scope.serverId })));
      } catch {
        // Local results remain useful when one selected server is unavailable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOT_NEW_RELEASE_CONCURRENCY, scopes.length) }, worker));
  if (results.length === 0) return [];
  try {
    const resolutions = await libraryResolveAlbumOverlay({
      scopes,
      albums: results.map(album => ({
        serverId: album.serverId ?? '',
          id: album.id,
          name: album.name,
          artist: album.displayArtist?.trim() || album.artist?.trim() || null,
          version: album.version?.trim()
            || albumVersionFromTags(album.tags)
            || null,
        })),
    });
    if (resolutions.length !== results.length) return [];
    return results.map((album, index) => ({ album, ...resolutions[index]! }));
  } catch {
    // The overlay is optional; never reintroduce raw, identity-unsafe rows.
    return [];
  }
}
