import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  albumCoverRef,
  albumCoverRefForPlayback,
  albumCoverRefForSong,
  artistCoverRef,
  navidromeDiscCoverRef,
  resolveAlbumDiscCount,
  resolveDistinctDiscCoversForAlbum,
  resolvePlaybackCoverScope,
} from './ref';
import { songHasDiscSpecificCover } from './resolveEntry';
import { isNavidromeServer } from '@/lib/server/subsonicServerIdentity';
import { coverServerScopeForServerId } from './serverScope';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { queueItemRefMatchesTrack } from '@/features/playback/utils/playback/queueIdentity';
import {
  resolveAlbumCoverRefFromLibrary,
  resolveArtistCoverRefFromLibrary,
  resolveLibraryAlbumDiscCount,
  resolveTrackCoverRefFromLibrary,
} from './resolveEntryLibrary';
import { COVER_SCOPE_ACTIVE, coverScopeKey, type CoverArtRef, type CoverServerScope } from './types';

function coverRefsEqual(a: CoverArtRef, b: CoverArtRef): boolean {
  return (
    a.cacheKind === b.cacheKind
    && a.cacheEntityId === b.cacheEntityId
    && a.fetchCoverArtId === b.fetchCoverArtId
    && coverScopeKey(a.serverScope) === coverScopeKey(b.serverScope)
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

/**
 * Is the given server a Navidrome instance? Accepts either a profile id or a
 * library index key (queue refs carry the latter), resolving one to the other so
 * per-disc gating works from any cover surface.
 */
function useServerIsNavidrome(serverId: string | null | undefined): boolean {
  return useAuthStore(s => {
    if (!serverId) return false;
    let identity = s.subsonicServerIdentityByServer[serverId];
    if (!identity) {
      const profileId = resolveServerIdForIndexKey(serverId);
      if (profileId) identity = s.subsonicServerIdentityByServer[profileId];
    }
    return isNavidromeServer(identity);
  });
}

function albumMultiDiscKey(albumId: string, serverId: string | null | undefined): string {
  return `${serverId ?? ''}\u0000${albumId}`;
}

/**
 * Does this album span more than one disc? Reads the synchronous seed remembered
 * from a known tracklist / prior index lookup first, then (only when `enabled`,
 * i.e. the server supports per-disc art) resolves the count from the local index.
 * Kept keyed to the resolved album so a stale async result never leaks onto a
 * different album while the next lookup is in flight.
 */
function useAlbumMultiDisc(
  albumId: string | null | undefined,
  serverId: string | null | undefined,
  enabled: boolean,
): boolean {
  const seededMulti = useMemo(() => {
    const al = albumId?.trim();
    if (!al) return undefined;
    const count = resolveAlbumDiscCount(al, serverId);
    return count == null ? undefined : count > 1;
  }, [albumId, serverId]);

  const [fetched, setFetched] = useState<{ key: string; multi: boolean } | undefined>(undefined);

  useEffect(() => {
    const al = albumId?.trim();
    if (!enabled || !al || seededMulti != null) return;
    let cancelled = false;
    void resolveLibraryAlbumDiscCount(al, serverId).then(count => {
      if (!cancelled) setFetched({ key: albumMultiDiscKey(al, serverId), multi: count > 1 });
    });
    return () => {
      cancelled = true;
    };
  }, [albumId, serverId, enabled, seededMulti]);

  if (!enabled) return false;
  if (seededMulti != null) return seededMulti;
  const al = albumId?.trim();
  if (al && fetched && fetched.key === albumMultiDiscKey(al, serverId)) return fetched.multi;
  return false;
}

/**
 * Per-disc cover ref for a track — the server's canonical `dc-<albumId>:<disc>` slot,
 * but only on Navidrome and only for genuine multi-disc albums. Returns `undefined`
 * otherwise so the caller keeps the shared album-scoped cover (single-disc albums,
 * non-Navidrome servers). This is what makes the queue, playbar mini-cover and
 * album track rows show the right disc art, matching the disc separators.
 */
function useMultiDiscScopedCoverRef(
  albumId: string | null | undefined,
  discNumber: number | null | undefined,
  serverId: string | null | undefined,
  serverScope: CoverServerScope,
  enabled = true,
): CoverArtRef | undefined {
  const isNavidrome = useServerIsNavidrome(serverId);
  // Gate the disc-count lookup on both Navidrome (only it serves `dc-*` art) and the
  // caller opting into library resolution — browse rails (`libraryResolve: false`)
  // must stay IPC-free and album-scoped, exactly like main.
  const resolveDiscScope = enabled && isNavidrome;
  const multiDisc = useAlbumMultiDisc(albumId, serverId, resolveDiscScope);
  const scopeKey = coverScopeKey(serverScope);
  return useMemo(() => {
    if (!resolveDiscScope || !multiDisc) return undefined;
    const al = albumId?.trim();
    if (!al || discNumber == null) return undefined;
    return navidromeDiscCoverRef(al, discNumber, serverScope);
    // serverScope keyed via the stable `scopeKey` string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveDiscScope, multiDisc, albumId, discNumber, scopeKey]);
}

export type LibraryCoverRefOptions = {
  /**
   * When false, use API/index `coverArt` only — no per-mount `library_resolve_cover_entry`.
   * Default for browse/search grids is false at the component layer; enable on album/artist
   * detail headers and queue rows that need per-disc slots from SQLite.
   */
  libraryResolve?: boolean;
  /**
   * Force per-disc cover resolution regardless of the album-level
   * `resolveDistinctDiscCoversForAlbum` verdict. Opt-in for surfaces that render at
   * most **one cover per disc** (the multi-disc separator), where resolving the disc's
   * own art carries no per-song cache-explosion risk. Callers should gate this on
   * {@link songHasDiscSpecificCover} so the album-fallback shapes still resolve
   * `al-<albumId>_0`; do NOT enable it on per-song surfaces (queue rows, track rows).
   */
  forceDistinctDiscCovers?: boolean;
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
    () => resolveDistinctDiscCoversForAlbum(albumId ?? ''),
    [albumId],
  );
  const syncRef = useMemo(() => {
    const id = albumId?.trim();
    if (!id) return null;
    return albumCoverRef(id, fallbackCoverArt, { serverScope, distinctDiscCovers });
    // `serverScope` is keyed via stable `scopeKey` — see effect deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId, fallbackCoverArt, scopeKey, distinctDiscCovers]);

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

/**
 * Browse track-list rows — **library fetch id first**, then mount CoverArtImage.
 * SQLite often stores per-track `mf-*` in `cover_art_id`; the sync album ref would
 * race ensure with the wrong id before `library_resolve_cover_entry` returns the
 * album row's `al-*` (or album id fallback).
 */
export function useBrowseListAlbumCoverRef(
  albumId: string | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | null {
  const scopeKey = coverScopeKey(serverScope);
  const id = albumId?.trim() ?? '';
  const [ref, setRef] = useState<CoverArtRef | null>(null);

  useEffect(() => {
    if (!id) {
      // React Compiler set-state-in-effect rule: clear stale ref when album id disappears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRef(null);
      return;
    }
    let cancelled = false;
    setRef(null);
    void resolveAlbumCoverRefFromLibrary(id, id, serverScope).then(next => {
      if (!cancelled) setRef(next);
    });
    return () => {
      cancelled = true;
    };
    // serverScope keyed via scopeKey — see useAlbumCoverRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scopeKey]);

  return ref;
}

/** Multi-disc browse rows — library-resolved per-disc slot before ensure. */
export function useBrowseListTrackCoverRef(
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | undefined {
  const scopeKey = coverScopeKey(serverScope);
  const songId = song?.id?.trim() ?? '';
  const albumId = song?.albumId?.trim() ?? '';
  const coverArt = song?.coverArt;
  const discNumber = song?.discNumber;
  const [ref, setRef] = useState<CoverArtRef | undefined>(undefined);

  useEffect(() => {
    if (!songId || !albumId || !song) {
      // React Compiler set-state-in-effect rule: clear stale ref when track identity clears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRef(undefined);
      return;
    }
    let cancelled = false;
    setRef(undefined);
    void resolveTrackCoverRefFromLibrary(
      { id: songId, albumId, coverArt, discNumber },
      serverScope,
    ).then(next => {
      if (!cancelled) setRef(next ?? undefined);
    });
    return () => {
      cancelled = true;
    };
    // serverScope keyed via scopeKey — see useTrackCoverRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, albumId, coverArt, discNumber, scopeKey]);

  return ref;
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
    // `serverScope` is keyed via stable `scopeKey` — see effect deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistId, fallbackCoverArt, scopeKey]);

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
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'> | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
  options?: LibraryCoverRefOptions,
): CoverArtRef | undefined {
  const libraryResolve = options?.libraryResolve !== false;
  const forceDistinctDiscCovers = options?.forceDistinctDiscCovers === true;
  const scopeKey = coverScopeKey(serverScope);
  const songId = song?.id;
  const albumId = song?.albumId;
  const coverArt = song?.coverArt;
  const discNumber = song?.discNumber;
  const serverId = song?.serverId;

  const distinctDiscCovers = useMemo(
    () =>
      forceDistinctDiscCovers
      || (albumId?.trim() ? resolveDistinctDiscCoversForAlbum(albumId, serverId) : false),
    [albumId, serverId, forceDistinctDiscCovers],
  );

  // Navidrome multi-disc albums: prefer the canonical per-disc slot over the
  // album-scoped ref so a track's row shows its own disc art (matches the queue).
  // Gated on libraryResolve so browse rails stay IPC-free / album-scoped like main.
  const discScopedRef = useMultiDiscScopedCoverRef(
    albumId,
    discNumber,
    serverId,
    serverScope,
    libraryResolve,
  );

  const syncRef = useMemo(() => {
    if (!songId?.trim() || !albumId?.trim()) return undefined;
    return albumCoverRefForSong(
      { id: songId, albumId, coverArt, discNumber, serverId },
      distinctDiscCovers,
      serverScope,
    );
    // `serverScope` is keyed via stable `scopeKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, albumId, coverArt, discNumber, serverId, distinctDiscCovers, scopeKey]);

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

  return discScopedRef ?? (libraryResolve ? ref : syncRef);
}

/**
 * Cover for a multi-disc separator ("CD N") — resolved from the disc's representative
 * (first) track. On Navidrome it uses the server's canonical per-disc artwork id
 * (`dc-<albumId>:<discNumber>` via {@link navidromeDiscCoverRef}): one cache slot per
 * disc, correct per-disc art even when the disc's tracks carry per-track `mf-*` ids that
 * the album-level `resolveDistinctDiscCoversForAlbum` heuristic can't recognise, and it
 * needs no per-track `coverArt` (so it also works from the local index).
 *
 * On non-Navidrome servers `dc-*` is unavailable, so it falls back to the standard
 * track-cover path, forcing per-disc resolution only when the disc's own track carries a
 * usable disc-specific cover id ({@link songHasDiscSpecificCover}); otherwise it stays
 * album-scoped (`al-<albumId>_0`), matching the queue / hero.
 *
 * Only for surfaces that render at most ONE cover per disc — do not use per song.
 */
export function useDiscCoverRef(
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'>,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | undefined {
  const isNavidrome = useServerIsNavidrome(song.serverId);
  const scopeKey = coverScopeKey(serverScope);
  const albumId = song.albumId;
  const discNumber = song.discNumber;

  const discRef = useMemo(() => {
    if (!isNavidrome) return undefined;
    const al = albumId?.trim();
    if (!al || discNumber == null) return undefined;
    return navidromeDiscCoverRef(al, discNumber, serverScope);
    // serverScope keyed via the stable `scopeKey` string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNavidrome, albumId, discNumber, scopeKey]);

  // Non-Navidrome fallback: per-disc from the disc's own track only when it carries a
  // usable disc-specific cover id; the standard resolver otherwise stays album-scoped.
  const fallbackRef = useTrackCoverRef(song, serverScope, {
    forceDistinctDiscCovers: !isNavidrome && songHasDiscSpecificCover(song),
    libraryResolve: !isNavidrome,
  });

  return discRef ?? fallbackRef;
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
      if (ref && queueItemRefMatchesTrack(ref, track)) {
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
  const serverId = track?.serverId;

  // Navidrome multi-disc albums: the playbar mini-cover / queue rows follow the
  // playing track's disc via its canonical `dc-<albumId>:<disc>` slot.
  const discScopedRef = useMultiDiscScopedCoverRef(albumId, discNumber, serverId, scope);

  const syncRef = useMemo(() => {
    if (!albumId?.trim() || !track) return undefined;
    return albumCoverRefForPlayback(track, scope);
    // `scope` is keyed via the stable `scopeKey` string; the primitive track
    // fields recompute the ref when the playing track changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, trackId, albumId, coverArt, discNumber, serverId, scopeKey]);

  const [ref, setRef] = useState<CoverArtRef | undefined>(syncRef);

  useEffect(() => {
    applySyncRef(setRef, syncRef);
    const tid = trackId?.trim();
    const al = albumId?.trim();
    if (!tid || !al || !track) return;
    let cancelled = false;
    const distinctDiscCovers = resolveDistinctDiscCoversForAlbum(al, serverId);
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
  }, [track, trackId, albumId, coverArt, discNumber, serverId, scopeKey, syncRef]);

  return discScopedRef ?? ref;
}

/**
 * "Who is listening" presence rows — the cover for a track someone else is
 * playing. Follows the same disc logic as the queue/playbar: the canonical
 * `dc-<albumId>:<disc>` slot for genuine multi-disc Navidrome albums (so a disc-2
 * track shows disc-2 art), otherwise the shared album cover. It deliberately does
 * NOT feed the playing track's per-file `mf-*` id into the album slot the grid and
 * hero also use — that would thrash / pollute the album cover cache.
 */
export function usePresenceCoverRef(
  song: Pick<SubsonicSong, 'albumId' | 'discNumber' | 'serverId'> | null | undefined,
  serverScope: CoverServerScope = COVER_SCOPE_ACTIVE,
): CoverArtRef | null {
  const albumId = song?.albumId;
  const discNumber = song?.discNumber;
  const serverId = song?.serverId;
  const discScopedRef = useMultiDiscScopedCoverRef(albumId, discNumber, serverId, serverScope);
  const albumRef = useAlbumCoverRef(albumId ?? null, undefined, serverScope, {
    libraryResolve: true,
  });
  return discScopedRef ?? albumRef;
}
