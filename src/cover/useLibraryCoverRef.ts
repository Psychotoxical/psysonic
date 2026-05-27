import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import {
  albumCoverRef,
  albumCoverRefForPlayback,
  albumCoverRefForSong,
  artistCoverRef,
  resolvePlaybackCoverScope,
} from './ref';
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

/** Album grid / card — sync fallback, then local library index when indexed. */
export function useAlbumCoverRef(
  albumId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | null {
  const scopeKey = coverScopeKey(serverScope);
  const syncRef = useMemo(() => {
    const id = albumId?.trim();
    if (!id) return null;
    return albumCoverRef(id, fallbackCoverArt, serverScope);
  }, [albumId, fallbackCoverArt, scopeKey, serverScope]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
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
  }, [albumId, fallbackCoverArt, scopeKey, syncRef]);

  return ref;
}

/** Artist grid — sync fallback, then library index. */
export function useArtistCoverRef(
  artistId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | null {
  const scopeKey = coverScopeKey(serverScope);
  const syncRef = useMemo(() => {
    const id = artistId?.trim();
    if (!id) return null;
    return artistCoverRef(id, fallbackCoverArt, serverScope);
  }, [artistId, fallbackCoverArt, scopeKey, serverScope]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
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
  }, [artistId, fallbackCoverArt, scopeKey, syncRef]);

  return ref;
}

/** Track row / song card — album-scoped; multi-CD from library when indexed. */
export function useTrackCoverRef(
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | undefined {
  const scopeKey = coverScopeKey(serverScope);
  const songId = song?.id;
  const albumId = song?.albumId;
  const coverArt = song?.coverArt;
  const discNumber = song?.discNumber;

  const syncRef = useMemo(() => {
    if (!songId?.trim() || !albumId?.trim()) return undefined;
    return albumCoverRefForSong({ id: songId, albumId, coverArt, discNumber });
  }, [songId, albumId, coverArt, discNumber]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    const trackId = songId?.trim();
    const al = albumId?.trim();
    if (!trackId || !al || !song) return;
    let cancelled = false;
    void resolveTrackCoverRefFromLibrary(
      { ...song, id: trackId, albumId: al },
      serverScope,
    ).then(next => {
      if (!cancelled) {
        setRef(prev => {
          if (!next) return undefined;
          if (prev && coverRefsEqual(prev, next)) return prev;
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [song, songId, albumId, coverArt, discNumber, scopeKey, syncRef]);

  return ref;
}

/** Now playing / queue — playback server scope + library-backed multi-CD. */
export function usePlaybackTrackCoverRef(
  track: Parameters<typeof albumCoverRefForPlayback>[0] | null | undefined,
): CoverArtRef | undefined {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueLength = usePlayerStore(s => s.queueItems.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serversFingerprint = useAuthStore(s =>
    s.servers
      .map(srv => `${srv.id}\u0001${srv.url}\u0001${srv.username}\u0001${srv.password}`)
      .join('\u0002'),
  );

  const scope = useMemo(
    () => resolvePlaybackCoverScope(),
    [queueServerId, queueLength, activeServerId, serversFingerprint],
  );
  const scopeKey = coverScopeKey(scope);

  const trackId = track?.id;
  const albumId = track?.albumId;
  const coverArt = track?.coverArt;
  const discNumber = (track as { discNumber?: number } | null | undefined)?.discNumber;

  const syncRef = useMemo(() => {
    if (!albumId?.trim() || !track) return undefined;
    return albumCoverRefForPlayback(track, scope);
  }, [track, trackId, albumId, coverArt, discNumber, scopeKey]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    const tid = trackId?.trim();
    const al = albumId?.trim();
    if (!tid || !al || !track) return;
    let cancelled = false;
    void resolveTrackCoverRefFromLibrary(
      { ...track, id: tid, albumId: al } as Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>,
      scope,
    ).then(next => {
      if (!cancelled) {
        setRef(prev => {
          if (!next) return prev;
          if (prev && coverRefsEqual(prev, next)) return prev;
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [track, trackId, albumId, coverArt, discNumber, scopeKey, syncRef]);

  return ref;
}
