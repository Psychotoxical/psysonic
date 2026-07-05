// Media-resolution seam. The audio core needs album/artist/playlist data that
// respects offline-browse mode, but that policy lives in @/features/offline and
// the core must not import a feature (iron rule). So the offline feature registers
// its offline-aware resolver here at boot (see offlineMediaResolve.ts module init,
// loaded eagerly via the @/features/offline barrel that AppShell imports); the
// audio core calls these neutral delegators.
//
// Default (unregistered) = network-only: a safety net that never runs in practice
// because the offline feature always registers at boot. It deliberately omits the
// library-index / offline-bytes branches (those live in the feature) — it only
// guarantees a sane fallback, not the full policy.
import type { SubsonicAlbum, SubsonicArtist, SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import { useAuthStore } from '@/store/authStore';

export type ResolvedAlbum = { album: SubsonicAlbum; songs: SubsonicSong[] };
export type ResolvedArtist = { artist: SubsonicArtist; albums: SubsonicAlbum[] };
export type ResolvedPlaylist = { playlist: SubsonicPlaylist; songs: SubsonicSong[] };

export interface MediaResolver {
  resolveAlbum(serverId: string, albumId: string): Promise<ResolvedAlbum | null>;
  resolveArtist(serverId: string, artistId: string): Promise<ResolvedArtist | null>;
  resolvePlaylist(serverId: string, playlistId: string): Promise<ResolvedPlaylist | null>;
}

let registered: MediaResolver | null = null;

/** Offline feature installs its offline-aware policy here at module init. */
export function registerMediaResolver(resolver: MediaResolver): void {
  registered = resolver;
}

/** True once a resolver is installed. For the boot-registration smoke guard. */
export function isMediaResolverRegistered(): boolean {
  return registered !== null;
}

async function netAlbum(serverId: string, albumId: string): Promise<ResolvedAlbum | null> {
  try {
    const data = await getAlbumForServer(serverId, albumId);
    return { album: data.album, songs: data.songs };
  } catch {
    return null;
  }
}

async function netArtist(serverId: string, artistId: string): Promise<ResolvedArtist | null> {
  try {
    return await getArtistForServer(serverId, artistId);
  } catch {
    return null;
  }
}

async function netPlaylist(serverId: string, playlistId: string): Promise<ResolvedPlaylist | null> {
  try {
    return await getPlaylistForServer(serverId, playlistId);
  } catch {
    return null;
  }
}

export function resolveAlbum(serverId: string, albumId: string): Promise<ResolvedAlbum | null> {
  return (registered?.resolveAlbum ?? netAlbum)(serverId, albumId);
}

export function resolveArtist(serverId: string, artistId: string): Promise<ResolvedArtist | null> {
  return (registered?.resolveArtist ?? netArtist)(serverId, artistId);
}

export function resolvePlaylist(serverId: string, playlistId: string): Promise<ResolvedPlaylist | null> {
  return (registered?.resolvePlaylist ?? netPlaylist)(serverId, playlistId);
}

/** @deprecated Use {@link resolveAlbum}. */
export const resolveAlbumForServer = resolveAlbum;

export function resolveMediaServerId(explicit?: string | null): string | null {
  return explicit ?? useAuthStore.getState().activeServerId;
}

/** Resolve album for active server when `serverId` omitted. */
export async function resolveAlbumForActiveServer(
  albumId: string,
  serverId?: string,
): Promise<ResolvedAlbum | null> {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid) return null;
  return resolveAlbum(sid, albumId);
}
