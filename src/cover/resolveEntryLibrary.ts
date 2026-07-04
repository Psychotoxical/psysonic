/**
 * Cover resolution backed by the local library index — preferred over live API fields
 * when the album/artist/track row exists in SQLite.
 */

import { commands } from '@/generated/bindings';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { useAuthStore } from '../store/authStore';
import { COVER_SCOPE_ACTIVE, type CoverArtRef, CoverCacheKind, CoverServerScope } from './types';
import {
  coverEntryToRef,
  resolveAlbumCoverEntry,
  resolveArtistCoverEntry,
  resolveTrackCoverEntry,
  resolveSongFetchCoverArtId,
  type CoverEntry,
} from './resolveEntry';
import { resolveDistinctDiscCoversForAlbum } from './ref';
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

function libraryResolveCacheKey(
  serverId: string,
  entity: CoverLibraryEntity,
  entityId: string,
): string {
  return `${librarySqlServerId(serverId)}\u0000${entity}\u0000${entityId.trim()}`;
}

const resolvedEntryCache = new Map<string, CoverEntry | null>();
const inflightResolves = new Map<string, Promise<CoverEntry | null>>();
const MAX_RESOLVED_ENTRY_CACHE = 4096;

function trimResolvedEntryCache(): void {
  while (resolvedEntryCache.size > MAX_RESOLVED_ENTRY_CACHE) {
    const oldest = resolvedEntryCache.keys().next().value;
    if (oldest === undefined) break;
    resolvedEntryCache.delete(oldest);
  }
}

const LIBRARY_RESOLVE_MAX_INFLIGHT = 4;
let libraryResolveActive = 0;
const libraryResolveWaiters: Array<() => void> = [];

function runLibraryResolveLimited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      libraryResolveActive += 1;
      fn()
        .then(resolve, reject)
        .finally(() => {
          libraryResolveActive -= 1;
          const next = libraryResolveWaiters.shift();
          if (next) next();
        });
    };
    if (libraryResolveActive < LIBRARY_RESOLVE_MAX_INFLIGHT) start();
    else libraryResolveWaiters.push(start);
  });
}

export async function libraryResolveCoverEntry(
  serverId: string,
  entity: CoverLibraryEntity,
  entityId: string,
): Promise<CoverEntry | null> {
  const id = entityId.trim();
  if (!id || !serverId.trim()) return null;

  const key = libraryResolveCacheKey(serverId, entity, id);
  if (resolvedEntryCache.has(key)) return resolvedEntryCache.get(key) ?? null;

  const inflight = inflightResolves.get(key);
  if (inflight) return inflight;

  const promise = runLibraryResolveLimited(async () => {
    try {
      const res = await commands.libraryResolveCoverEntry(librarySqlServerId(serverId), entity, id);
      if (res.status === 'error') throw new Error(res.error);
      const dto = res.data as LibraryCoverEntryDto | null;
      const entry = dto ? dtoToEntry(dto) : null;
      resolvedEntryCache.set(key, entry);
      trimResolvedEntryCache();
      return entry;
    } catch {
      resolvedEntryCache.set(key, null);
      trimResolvedEntryCache();
      return null;
    } finally {
      inflightResolves.delete(key);
    }
  });

  inflightResolves.set(key, promise);
  return promise;
}

export async function resolveAlbumCoverRefFromLibrary(
  albumId: string,
  fallbackCoverArt: string | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): Promise<CoverArtRef> {
  const entry =
    (await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'album', albumId))
    ?? resolveAlbumCoverEntry(albumId, fallbackCoverArt);
  return coverEntryToRef(entry!, serverScope);
}

export async function resolveArtistCoverRefFromLibrary(
  artistId: string,
  fallbackCoverArt: string | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): Promise<CoverArtRef> {
  const entry =
    (await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'artist', artistId))
    ?? resolveArtistCoverEntry(artistId, fallbackCoverArt);
  return coverEntryToRef(entry!, serverScope);
}

function pickTrackCoverEntry(
  song: Parameters<typeof resolveTrackCoverEntry>[0],
  fromLibrary: CoverEntry | null,
  distinctDiscCovers: boolean,
): CoverEntry | undefined {
  const albumId = song.albumId?.trim();
  const fromClient = resolveTrackCoverEntry(song, distinctDiscCovers);
  if (!fromLibrary) return fromClient;
  if (!fromClient) return fromLibrary;

  const songArt = resolveSongFetchCoverArtId(song);
  const libraryIsAlbumBucket =
    Boolean(albumId)
    && fromLibrary.cacheEntityId === albumId
    && fromClient.cacheEntityId !== albumId;

  if (
    distinctDiscCovers
    && libraryIsAlbumBucket
    && songArt
    && fromClient.fetchCoverArtId === songArt
  ) {
    return fromClient;
  }

  if (fromClient.cacheEntityId !== fromLibrary.cacheEntityId && distinctDiscCovers) {
    return fromClient;
  }

  return fromLibrary;
}

export async function resolveTrackCoverRefFromLibrary(
  song: Parameters<typeof resolveTrackCoverEntry>[0],
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
  distinctDiscCovers?: boolean,
): Promise<CoverArtRef | undefined> {
  const albumId = song.albumId?.trim();
  const distinct =
    distinctDiscCovers
    ?? (albumId ? resolveDistinctDiscCoversForAlbum(albumId, song.coverArt, song) : false);
  const trackId = song.id?.trim();
  const fromLibrary = trackId
    ? await libraryResolveCoverEntry(libraryServerIdFromScope(serverScope), 'track', trackId)
    : null;
  const entry = pickTrackCoverEntry(song, fromLibrary, distinct);
  return entry ? coverEntryToRef(entry, serverScope) : undefined;
}

export async function resolveAlbumCoverRefsFromLibrary(
  albums: ReadonlyArray<{ id: string; coverArt?: string | null }>,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): Promise<CoverArtRef[]> {
  return Promise.all(
    albums.map(a => resolveAlbumCoverRefFromLibrary(a.id, a.coverArt, serverScope)),
  );
}

export async function resolveArtistCoverRefsFromLibrary(
  artists: ReadonlyArray<{ id: string; coverArt?: string | null }>,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): Promise<CoverArtRef[]> {
  return Promise.all(
    artists.map(a => resolveArtistCoverRefFromLibrary(a.id, a.coverArt, serverScope)),
  );
}

export async function resolveTrackCoverRefsFromLibrary(
  songs: ReadonlyArray<Parameters<typeof resolveTrackCoverEntry>[0]>,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): Promise<CoverArtRef[]> {
  const refs = await Promise.all(
    songs.map(s => resolveTrackCoverRefFromLibrary(s, serverScope)),
  );
  return refs.filter((r): r is CoverArtRef => !!r);
}
