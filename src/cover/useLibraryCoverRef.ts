import { useEffect, useMemo, useState } from 'react';
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
import type { CoverArtRef, CoverServerScope } from './types';

function coverRefsEqual(a: CoverArtRef, b: CoverArtRef): boolean {
  return (
    a.cacheKind === b.cacheKind
    && a.cacheEntityId === b.cacheEntityId
    && a.fetchCoverArtId === b.fetchCoverArtId
  );
}

/** Album grid / card — sync fallback, then local library index when indexed. */
export function useAlbumCoverRef(
  albumId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | null {
  const syncRef = useMemo(() => {
    const id = albumId?.trim();
    if (!id) return null;
    return albumCoverRef(id, fallbackCoverArt, serverScope);
  }, [albumId, fallbackCoverArt, serverScope]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    setRef(syncRef);
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
  }, [albumId, fallbackCoverArt, serverScope, syncRef]);

  return ref;
}

/** Artist grid — sync fallback, then library index. */
export function useArtistCoverRef(
  artistId: string | null | undefined,
  fallbackCoverArt?: string | null,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | null {
  const syncRef = useMemo(() => {
    const id = artistId?.trim();
    if (!id) return null;
    return artistCoverRef(id, fallbackCoverArt, serverScope);
  }, [artistId, fallbackCoverArt, serverScope]);

  const [ref, setRef] = useState<CoverArtRef | null>(syncRef);

  useEffect(() => {
    setRef(syncRef);
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
  }, [artistId, fallbackCoverArt, serverScope, syncRef]);

  return ref;
}

/** Track row / song card — album-scoped; multi-CD from library when indexed. */
export function useTrackCoverRef(
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> | null | undefined,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef | undefined {
  const syncRef = useMemo(() => {
    if (!song) return undefined;
    return albumCoverRefForSong(song);
  }, [song]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    setRef(syncRef);
    if (!song?.id?.trim()) return;
    let cancelled = false;
    void resolveTrackCoverRefFromLibrary(song, serverScope).then(next => {
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
  }, [song, serverScope, syncRef]);

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

  const syncRef = useMemo(() => {
    if (!track?.albumId?.trim()) return undefined;
    return albumCoverRefForPlayback(track, scope);
  }, [track, scope]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    setRef(syncRef);
    const trackId = track?.id?.trim();
    const albumId = track?.albumId?.trim();
    if (!trackId || !albumId) return;
    let cancelled = false;
    void resolveTrackCoverRefFromLibrary(
      { ...track, id: trackId, albumId } as Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>,
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
  }, [track, scope, syncRef]);

  return ref;
}
