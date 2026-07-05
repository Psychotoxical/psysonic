/**
 * Internal server-id ↔ index-key mapping helpers shared by the library command
 * wrappers (reads/sync/stats). Not part of the public `@/lib/api/library` barrel.
 */
import { useAuthStore } from '@/store/authStore';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import type { LibraryTrackDto } from './dto';

export function serverIndexKeyForId(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (!server) return serverId;
  return serverIndexKeyFromUrl(server.url) || serverId;
}

export function mapServerIdFromIndexKey(serverId: string, fallback?: string): string {
  if (fallback) return fallback;
  return resolveServerIdForIndexKey(serverId);
}

export function mapTracksServerId(
  tracks: LibraryTrackDto[],
  fallbackServerId?: string,
): LibraryTrackDto[] {
  if (tracks.length === 0) return tracks;
  return tracks.map(track => ({
    ...track,
    serverId: mapServerIdFromIndexKey(track.serverId, fallbackServerId),
  }));
}
