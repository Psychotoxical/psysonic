/**
 * Cover resolution backed by the local library index — preferred over live API fields
 * when the album/artist/track row exists in SQLite.
 */

import { invoke } from '@tauri-apps/api/core';
import { librarySqlServerId } from '../api/coverCache';
import { useAuthStore } from '../store/authStore';
import type { CoverArtRef, CoverCacheKind, CoverServerScope } from './types';
import {
  coverEntryToRef,
  resolveAlbumCoverEntry,
  resolveArtistCoverEntry,
  resolveTrackCoverEntry,
  type CoverEntry,
} from './resolveEntry';
import { coverIndexKeyFromScope } from './storageKeys';

export type LibraryCoverEntryDto = {
  cacheKind: CoverCacheKind;
  cacheEntityId: string;
  fetchCoverArtId: string;
};

export type CoverLibraryEntity = 'album' | 'artist' | 'track';

function dtoToEntry(dto: LibraryCoverEntryDto): CoverEntry {
  return {
    cacheKind: dto.cacheKind,
    cacheEntityId: dto.cacheEntityId,
    fetchCoverArtId: dto.fetchCoverArtId,
  };
}

export function libraryServerIdFromScope(scope: CoverServerScope): string {
  if (scope.kind === 'server') {
    return librarySqlServerId(scope.serverId);
  }
  const key = coverIndexKeyFromScope(scope);
  if (key && key !== '_') return librarySqlServerId(key);
  const active = useAuthStore.getState().activeServerId;
  return active ? librarySqlServerId(active) : '_';
}

export async function libraryResolveCoverEntry(
  serverId: string,
  entity: CoverLibraryEntity,
  entityId: string,
): Promise<CoverEntry | null> {
  const id = entityId.trim();
  if (!id || !serverId.trim()) return null;
  try {
    const dto = await invoke<LibraryCoverEntryDto | null>('library_resolve_cover_entry', {
      serverId: librarySqlServerId(serverId),
      entity,
      entityId: id,
    });
    return dto ? dtoToEntry(dto) : null;
  } catch {
    return null;
  }
}

export async function resolveAlbumCoverRefFromLibrary(
  albumId: string,
  fallbackCoverArt: string | null | undefined,
  serverScope: CoverServerScope = { kind: 'active' },
): Promise<CoverArtRef> {
  const entry =
    (await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'album', albumId))
    ?? resolveAlbumCoverEntry(albumId, fallbackCoverArt);
  return coverEntryToRef(entry!, serverScope);
}

export async function resolveArtistCoverRefFromLibrary(
  artistId: string,
  fallbackCoverArt: string | null | undefined,
  serverScope: CoverServerScope = { kind: 'active' },
): Promise<CoverArtRef> {
  const entry =
    (await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'artist', artistId))
    ?? resolveArtistCoverEntry(artistId, fallbackCoverArt);
  return coverEntryToRef(entry!, serverScope);
}

export async function resolveTrackCoverRefFromLibrary(
  song: Parameters<typeof resolveTrackCoverEntry>[0],
  serverScope: CoverServerScope = { kind: 'active' },
  distinctDiscCovers = false,
): Promise<CoverArtRef | undefined> {
  const trackId = song.id?.trim();
  const fromLibrary = trackId
    ? await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'track', trackId)
    : null;
  const entry = fromLibrary ?? resolveTrackCoverEntry(song, distinctDiscCovers);
  return entry ? coverEntryToRef(entry, serverScope) : undefined;
}
