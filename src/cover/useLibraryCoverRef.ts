import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import {
  albumCoverRef,
  albumCoverRefForPlayback,
  albumCoverRefForSong,
  artistCoverRef,
  resolveDistinctDiscCoversForAlbum,
  resolvePlaybackCoverScope,
} from './ref';
import { coverServerScopeForServerId } from './serverScope';
import { resolveServerIdForIndexKey } from '../utils/server/serverLookup';
import { sameQueueTrackId } from '../utils/playback/queueIdentity';
import {
  resolveAlbumCoverRefFromLibrary,
  resolveArtistCoverRefFromLibrary,
  resolveTrackCoverRefFromLibrary,
} from './resolveEntryLibrary';
import { COVER_SCOPE_ACTIVE, coverScopeKey, type CoverArtRef, type CoverServerScope } from './types';

function coverRefsEqual(a: CoverArtRef, b: CoverArtRef): boolean {
  return (
    a.cacheKind === b.cacheKind
    && a.cacheEntityId === b.cacheEntityId
    && a.fetchCoverArtId === b.fetchCoverArtId
  );
}

function applySyncRef<T extends CoverArtRef | null | undefined>(
  setRef: Dispatch<SetStateAction<T>>,
  syncRef: T,
): void {
  setRef(prev => {
    if (!syncRef) return syncRef;
    if (prev && coverRefsEqual(prev, syncRef)) return prev;
    return syncRef;
  });
}

export type LibraryCoverRefOptions = {
  /**
   * When false, use API/index `coverArt` only — no per-mount `library_resolve_cover_entry`.
   * Default for browse/search grids is false at the component layer; enable on album/artist
   * detail headers and queue rows that need per-disc slots from SQLite.
   */
  libraryResolve?: boolean;
};

/** Album grid / card — sync fallback, then local library index when indexed. */
export function useAlbumCoverRef(
  albumId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
  options?: LibraryCoverRefOptions,
): CoverArtRef | null {
  const libraryResolve = options?.libraryResolve !== false;
  const scopeKey = coverScopeKey(serverScope);
  const distinctDiscCovers = useMemo(
    () => resolveDistinctDiscCoversForAlbum(albumId ?? '', fallbackCoverArt),
    [albumId, fallbackCoverArt],
  );
  const syncRef = useMemo(() => {
    const id = albumId?.trim();
    if (!id) return null;
    return albumCoverRef(id, fallbackCoverArt, { serverScope, distinctDiscCovers });
  }, [albumId, fallbackCoverArt, serverScope, distinctDiscCovers]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    if (!libraryResolve) return;
    const id = albumId?.trim();
    if (!id) return;
    let cancelled = false;
    void resolveAlbumCoverRefFromLibrary(id, fallbackCoverArt, serverScope).then(next => {
      if (!cancelled) {
        setRef(prev => (prev && coverRefsEqual(prev, next) ? prev : next));
      }
    });
    return () => {
      cancelled = true;
    };
    // serverScope is keyed via the stable `scopeKey` string (and via syncRef);
    // depending on the object directly would re-resolve from SQLite on every
    // render when the scope identity changes but its content does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId, fallbackCoverArt, scopeKey, syncRef, libraryResolve]);

  return libraryResolve ? ref : syncRef;
}

/** Artist grid — sync fallback, then library index. */
export function useArtistCoverRef(
  artistId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
  options?: LibraryCoverRefOptions,
): CoverArtRef | null {
  const libraryResolve = options?.libraryResolve !== false;
  const scopeKey = coverScopeKey(serverScope);
  const syncRef = useMemo(() => {
    const id = artistId?.trim();
    if (!id) return null;
    return artistCoverRef(id, fallbackCoverArt, serverScope);
  }, [artistId, fallbackCoverArt, serverScope]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    if (!libraryResolve) return;
    const id = artistId?.trim();
    if (!id) return;
    let cancelled = false;
    void resolveArtistCoverRefFromLibrary(id, fallbackCoverArt, serverScope).then(next => {
      if (!cancelled) {
        setRef(prev => (prev && coverRefsEqual(prev, next) ? prev : next));
      }
    });
    return () => {
      cancelled = true;
    };
    // serverScope is keyed via the stable `scopeKey` string (and via syncRef);
    // depending on the object directly would re-resolve from SQLite on every
    // render when the scope identity changes but its content does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistId, fallbackCoverArt, scopeKey, syncRef, libraryResolve]);

  return libraryResolve ? ref : syncRef;
}

/** Track row / song card — album-scoped; multi-CD from library when indexed. */
export function useTrackCoverRef(
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
  options?: LibraryCoverRefOptions,
): CoverArtRef | undefined {
  const libraryResolve = options?.libraryResolve !== false;
  const scopeKey = coverScopeKey(serverScope);
  const songId = song?.id;
  const albumId = song?.albumId;
  const coverArt = song?.coverArt;
  const discNumber = song?.discNumber;

  const distinctDiscCovers = useMemo(
    () => (albumId?.trim()
      ? resolveDistinctDiscCoversForAlbum(albumId, coverArt, {
        id: songId ?? '',
        albumId,
        coverArt,
        discNumber,
      })
      : false),
    [albumId, coverArt, discNumber, songId],
  );

  const syncRef = useMemo(() => {
    if (!songId?.trim() || !albumId?.trim()) return undefined;
    return albumCoverRefForSong(
      { id: songId, albumId, coverArt, discNumber },
      distinctDiscCovers,
    );
  }, [songId, albumId, coverArt, discNumber, distinctDiscCovers]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    if (!libraryResolve) return;
    const trackId = songId?.trim();
    const al = albumId?.trim();
    if (!trackId || !al || !song) return;
    let cancelled = false;
    void resolveTrackCoverRefFromLibrary(
      { ...song, id: trackId, albumId: al },
      serverScope,
      distinctDiscCovers,
    ).then(next => {
      if (!cancelled) {
        setRef(prev => {
          if (!next) return undefined;
          if (
            prev
            && prev.cacheKind === 'album'
            && next.cacheKind === 'album'
            && al
            && next.cacheEntityId === al
            && prev.cacheEntityId !== al
            && prev.fetchCoverArtId !== next.fetchCoverArtId
          ) {
            return prev;
          }
          if (prev && coverRefsEqual(prev, next)) return prev;
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // serverScope is keyed via the stable `scopeKey` string; depending on the
    // object directly would re-resolve from SQLite on every render when the
    // scope identity changes but its content does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, songId, albumId, coverArt, discNumber, scopeKey, syncRef, libraryResolve, distinctDiscCovers]);

  return libraryResolve ? ref : syncRef;
}

/** Now playing / queue — playback server scope + library-backed multi-CD. */
export function usePlaybackTrackCoverRef(
  track: Parameters<typeof albumCoverRefForPlayback>[0] | null | undefined,
): CoverArtRef | undefined {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const queueItems = usePlayerStore(s => s.queueItems);
  const queueLength = usePlayerStore(s => s.queueItems.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serversFingerprint = useAuthStore(s =>
    s.servers
      .map(srv => `${srv.id}\u0001${srv.url}\u0001${srv.username}\u0001${srv.password}`)
      .join('\u0002'),
  );

  const scope = useMemo(() => {
    if (track?.id) {
      const ref = queueItems[queueIndex];
      if (ref && sameQueueTrackId(ref.trackId, track.id)) {
        const profileId = resolveServerIdForIndexKey(ref.serverId) || ref.serverId;
        return coverServerScopeForServerId(profileId);
      }
      const scopedTrack = track as { serverId?: string };
      if (scopedTrack.serverId) {
        return coverServerScopeForServerId(scopedTrack.serverId);
      }
    }
    return resolvePlaybackCoverScope();
    // queueServerId/queueLength/activeServerId/serversFingerprint look unused but
    // are intentional recompute triggers: resolvePlaybackCoverScope() and
    // resolveServerIdForIndexKey() read global server/queue state, so the scope
    // must re-derive when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, queueItems, queueIndex, queueServerId, queueLength, activeServerId, serversFingerprint]);
  const scopeKey = coverScopeKey(scope);

  const trackId = track?.id;
  const albumId = track?.albumId;
  const coverArt = track?.coverArt;
  const discNumber = track?.discNumber;

  const syncRef = useMemo(() => {
    if (!albumId?.trim() || !track) return undefined;
    return albumCoverRefForPlayback(track, scope);
    // `scope` is keyed via the stable `scopeKey` string; the primitive track
    // fields recompute the ref when the playing track changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, trackId, albumId, coverArt, discNumber, scopeKey]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    const tid = trackId?.trim();
    const al = albumId?.trim();
    if (!tid || !al || !track) return;
    let cancelled = false;
    const distinctDiscCovers = resolveDistinctDiscCoversForAlbum(al, track.coverArt, {
      id: tid,
      albumId: al,
      coverArt: track.coverArt,
      discNumber: track.discNumber,
    });
    void resolveTrackCoverRefFromLibrary(
      { ...track, id: tid, albumId: al } as Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>,
      scope,
      distinctDiscCovers,
    ).then(next => {
      if (!cancelled) {
        setRef(prev => {
          if (!next) return prev ?? next;
          if (
            prev
            && prev.cacheKind === 'album'
            && next.cacheKind === 'album'
            && next.cacheEntityId === al
            && prev.cacheEntityId !== al
            && prev.fetchCoverArtId !== next.fetchCoverArtId
          ) {
            return prev;
          }
          if (prev && coverRefsEqual(prev, next)) return prev;
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
    };
    // `scope` is keyed via the stable `scopeKey` string; depending on the object
    // directly would re-resolve from SQLite on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, trackId, albumId, coverArt, discNumber, scopeKey, syncRef]);

  return ref;
}
