import { libraryResolveEntitySources, type LibraryScopePair } from '@/lib/api/library';
import type { Track } from '@/lib/media/trackTypes';

/** Resolve each merged/indexed track to one concrete id owned by the target playlist server. */
export async function resolvePlaylistTargetTrackIds(
  targetServerId: string,
  tracks: readonly Track[],
  scopes: LibraryScopePair[],
): Promise<string[]> {
  const resolved = await Promise.all(tracks.map(async track => {
    const ownerServerId = track.serverId ?? targetServerId;
    if (ownerServerId === targetServerId) return track.id;
    const sources = await libraryResolveEntitySources(targetServerId, {
      entityType: 'track',
      anchorServerId: ownerServerId,
      anchorId: track.id,
      scopes,
    }).catch(() => []);
    return sources.find(source => source.serverId === targetServerId)?.id ?? null;
  }));
  return resolved.filter((id): id is string => id !== null);
}
