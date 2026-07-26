import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { search, searchForServer } from '@/lib/api/subsonicSearch';
import {
  getArtist, getArtistForServer, getArtistInfo, getArtistInfoForServer, getTopSongs, getTopSongsForServer,
} from '@/lib/api/subsonicArtists';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo, SubsonicSong,
} from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { loadArtistFromLibraryIndex } from '@/features/offline';
import { useOfflineBrowseContext } from '@/features/offline';
import { loadArtistFromLocalPlayback, offlineLocalBrowseEnabled } from '@/features/offline';
import { readDetailServerId } from '@/lib/navigation/detailServerScope';
import { runLocalArtistLosslessBrowse } from '@/lib/library/browseTextSearch';
import { isLosslessSuffix } from '@/lib/library/losslessFormats';
import { tryLoadArtistDetailMultiScope } from '@/lib/library/loadArtistDetailMultiScope';
import { getLibraryBrowseScope } from '@/lib/library/libraryBrowseScope';
import { loadScopedArtistTopSongs } from '@/lib/library/loadScopedArtistTopSongs';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';

export interface UseArtistDetailDataOptions {
  /** When true, albums and top tracks are limited to lossless containers (local index preferred). */
  losslessOnly?: boolean;
}

export interface ArtistDetailDataResult {
  artist: SubsonicArtist | null;
  setArtist: React.Dispatch<React.SetStateAction<SubsonicArtist | null>>;
  albums: SubsonicAlbum[];
  topSongs: SubsonicSong[];
  info: SubsonicArtistInfo | null;
  /**
   * Server `info` was resolved against, or null while nobody may answer. Ids inside
   * `info` (similar artists) are local to this server, so anything the page derives from
   * them has to carry it — the active server is a different entity under a browse scope.
   */
  infoServerId: string | null;
  /** True when *that* server has AudioMuse-Navidrome, i.e. when `info.similarArtist` is meant to be shown. */
  audiomuseNavidromeEnabled: boolean;
  featuredAlbums: SubsonicAlbum[];
  loading: boolean;
  topSongsLoading: boolean;
  artistInfoLoading: boolean;
  featuredLoading: boolean;
  isStarred: boolean;
  setIsStarred: React.Dispatch<React.SetStateAction<boolean>>;
  losslessOnly: boolean;
}

function filterNetworkArtistToLossless(
  albums: SubsonicAlbum[],
  songs: SubsonicSong[],
): { albums: SubsonicAlbum[]; songs: SubsonicSong[] } {
  const losslessSongs = songs.filter(s => isLosslessSuffix(s.suffix));
  const albumIds = new Set(losslessSongs.map(s => s.albumId).filter(Boolean));
  return {
    albums: albums.filter(a => albumIds.has(a.id)),
    songs: losslessSongs,
  };
}

/** Owning server reported by the artist row the scoped loader resolved. */
interface ArtistInfoOwner {
  /** Route artist id this owner was resolved for — a later route keeps its own. */
  forId: string;
  serverId: string;
  artistId: string;
}

/** Where an identity-bound artist-info request may go, or null while nobody may answer. */
interface ArtistInfoTarget {
  serverId: string | null;
  artistId: string;
}

/**
 * Pick who may answer identity-bound artist info (biography, Last.fm link).
 *
 * Artist ids are server-local, so such a request has to reach the server the artist
 * really came from. `?server=` on the route names that owner; without it the artist row
 * the scoped loader returned names its own. Both beat the route-or-active fallback,
 * including under a single-server scope: browsing one server while a *different* one is
 * active is an ordinary selection, and the fallback would then answer from the active
 * server for whatever artist happens to carry that id there. Only when neither owner is
 * known does the scope decide — a single-server scope has just one candidate and keeps
 * the fallback (unscoped when there is none), while under multiple servers any pick
 * would be a guess, so nothing is requested at all.
 */
function resolveArtistInfoTarget(args: {
  id: string | undefined;
  routeServerId: string | null;
  fallbackServerId: string | null;
  loadedOwner: ArtistInfoOwner | null;
  multiServer: boolean;
}): ArtistInfoTarget | null {
  const { id, routeServerId, fallbackServerId, loadedOwner, multiServer } = args;
  if (!id) return null;
  if (routeServerId) return { serverId: routeServerId, artistId: id };
  if (loadedOwner && loadedOwner.forId === id) {
    return { serverId: loadedOwner.serverId, artistId: loadedOwner.artistId };
  }
  if (!multiServer) return { serverId: fallbackServerId, artistId: id };
  return null;
}

export function useArtistDetailData(
  id: string | undefined,
  options: UseArtistDetailDataOptions = {},
): ArtistDetailDataResult {
  const losslessOnly = options.losslessOnly ?? false;
  const activeServerId = useAuthStore(s => s.activeServerId);
  const [searchParams] = useSearchParams();
  const serverId = readDetailServerId(searchParams, activeServerId);
  // Same lookup without the active-server fallback: this tells apart a route that names
  // its owning server from one where `serverId` is only "the active server" standing in.
  const routeServerId = readDetailServerId(searchParams, null);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const { status: connStatus } = useConnectionStatus();
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const browseScope = getLibraryBrowseScope();
  const offlineBrowseActive = useOfflineBrowseContext().active && !!serverId;
  const preferLocalBytesOnly = offlineBrowseActive && offlineLocalBrowseEnabled(serverId);
  const preferLocalArtist = preferLocalBytesOnly
    || (connStatus === 'disconnected' && favoritesOfflineEnabled && !!serverId);

  const [artist, setArtist] = useState<SubsonicArtist | null>(null);
  const [artistOwner, setArtistOwner] = useState<ArtistInfoOwner | null>(null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [featuredAlbums, setFeaturedAlbums] = useState<SubsonicAlbum[]>([]);
  const [topSongs, setTopSongs] = useState<SubsonicSong[]>([]);
  const [infoEntry, setInfoEntry] = useState<{ id: string; value: SubsonicArtistInfo | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [topSongsLoading, setTopSongsLoading] = useState(false);
  const [isStarred, setIsStarred] = useState(false);
  const [artistInfoLoading, setArtistInfoLoading] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setInfoEntry(null);
    setTopSongs([]);
    setTopSongsLoading(false);
    setFeaturedAlbums([]);
    // Drop the owner before every scoped load, not only when the next one wins a row.
    // It is an answer about one particular scope: once the selection changes, or the
    // refreshed load returns nothing, keeping it would let an ownerless route query a
    // server that is no longer selected and show that server's artist information.
    setArtistOwner(null);

    (async () => {
      try {
        const currentBrowseScope = getLibraryBrowseScope();
        if (offlineBrowseActive && !preferLocalBytesOnly) {
          setLoading(false);
          return;
        }
        if (serverId && currentBrowseScope.pairs.length > 0) {
          const multi = losslessOnly
            ? await tryLoadArtistDetailMultiScope(currentBrowseScope.pairs, serverId, id, null)
            : await tryLoadArtistDetailMultiScope(currentBrowseScope.pairs, serverId, id);
          if (cancelled) return;
          if (multi) {
            setArtist(multi.artist);
            // The merged row carries the server it won on, which is the only owner a
            // route without `?server=` has. This is the sole loader reachable under a
            // multi-server scope, so no other branch has to report one.
            setArtistOwner(multi.artist.serverId && multi.artist.id
              ? { forId: id, serverId: multi.artist.serverId, artistId: multi.artist.id }
              : null);
            setIsStarred(!!multi.artist.starred);
            setAlbums(multi.albums);
            // "Appears on" is split locally from the same scoped album set, so it
            // works under multi-server scopes and needs no network search (the
            // network path below is disabled once the local index is authoritative).
            // `?? []` guards against an older payload without the field.
            setFeaturedAlbums(multi.appearsOnAlbums ?? []);
            setTopSongs(multi.topSongs);
            setLoading(false);
            if (
              !losslessOnly
              && multi.topTracksServerId
              && multi.topTracksFingerprint
              && shouldAttemptSubsonicForServer(multi.topTracksServerId)
            ) {
              setTopSongsLoading(true);
              try {
                const ranked = await loadScopedArtistTopSongs({
                  artistName: multi.artist.name,
                  sourceServerId: multi.topTracksServerId,
                  scopes: currentBrowseScope.pairs,
                  localFallback: multi.topSongs,
                  tracksFingerprint: multi.topTracksFingerprint,
                }).catch(() => multi.topSongs);
                if (cancelled) return;
                setTopSongs(ranked);
              } finally {
                if (!cancelled) setTopSongsLoading(false);
              }
            }
            return;
          }
          setLoading(false);
          return;
        }
        if (preferLocalArtist && serverId && id) {
          const local = preferLocalBytesOnly
            ? await loadArtistFromLocalPlayback(serverId, id)
            : await loadArtistFromLibraryIndex(serverId, id);
          if (cancelled) return;
          if (local) {
            setArtist(local.artist);
            setIsStarred(!!local.artist.starred);
            setAlbums(local.albums);
            // Preserve the own / appears-on split offline, so the artist page keeps
            // its "Also featured on" section instead of merging everything into the
            // main discography.
            setFeaturedAlbums(local.appearsOnAlbums);
            setTopSongs([]);
            setLoading(false);
            return;
          }
          if (preferLocalBytesOnly) {
            setLoading(false);
            return;
          }
        }

        if (losslessOnly && serverId) {
          const local = await runLocalArtistLosslessBrowse(serverId, id);
          if (cancelled) return;
          if (local) {
            const artistData = serverId
              ? await getArtistForServer(serverId, id).catch(() => null)
              : await getArtist(id).catch(() => null);
            if (cancelled) return;
            if (artistData) {
              setArtist(artistData.artist);
              setIsStarred(!!artistData.artist.starred);
            }
            setAlbums(local.albums);
            setTopSongs([...local.songs].sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0)));
            setLoading(false);
            return;
          }
        }

        const artistData = serverId
          ? await getArtistForServer(serverId, id)
          : await getArtist(id);
        if (cancelled) return;
        setArtist(artistData.artist);
        let nextAlbums = artistData.albums;
        setIsStarred(!!artistData.artist.starred);
        setLoading(false);

        const canLoadTopSongs = !serverId || shouldAttemptSubsonicForServer(serverId);
        if (!canLoadTopSongs) return;
        setTopSongsLoading(true);
        const songsData = await (serverId
          ? getTopSongsForServer(serverId, artistData.artist.name)
          : getTopSongs(artistData.artist.name)
        ).catch(() => [] as SubsonicSong[]);
        if (cancelled) return;
        let nextSongs = songsData ?? [];
        if (losslessOnly) {
          ({ albums: nextAlbums, songs: nextSongs } = filterNetworkArtistToLossless(nextAlbums, nextSongs));
        }
        setAlbums(nextAlbums);
        setTopSongs(nextSongs);
        setTopSongsLoading(false);
      } catch (err) {
        if (cancelled) return;
        // Network `getArtist` can fail for an id that is a valid card link but
        // has no `getArtist` entry — e.g. an album-artist surfaced by Random
        // Albums whose id resolves the album fine but not the artist. Fall back
        // to the local library index (the same id space the card came from)
        // before showing "Artist not found"; this also keeps artist pages
        // reachable on a transient network hiccup when the library is indexed.
        if (serverId && id) {
          try {
            const local = preferLocalBytesOnly
              ? await loadArtistFromLocalPlayback(serverId, id)
              : await loadArtistFromLibraryIndex(serverId, id);
            if (cancelled) return;
            if (local) {
              setArtist(local.artist);
              setIsStarred(!!local.artist.starred);
              setAlbums(local.albums);
              setFeaturedAlbums(local.appearsOnAlbums);
              setTopSongs([]);
              setLoading(false);
              return;
            }
          } catch { /* ignore */ }
        }
        console.error(err);
        setTopSongsLoading(false);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [
    id,
    libraryBrowseScopeVersion,
    losslessOnly,
    offlineBrowseActive,
    preferLocalArtist,
    preferLocalBytesOnly,
    searchParams,
    serverId,
  ]);

  const infoTarget = resolveArtistInfoTarget({
    id,
    routeServerId,
    fallbackServerId: serverId,
    loadedOwner: artistOwner,
    multiServer: browseScope.multiServer,
  });
  const infoServerId = infoTarget?.serverId ?? null;
  const infoArtistId = infoTarget?.artistId ?? null;
  // Read the AudioMuse flag for the server this page's identity actually resolved to,
  // not for the active one. They differ whenever the artist is owned elsewhere, and the
  // flag both parameterises the request below (`similarArtistCount`) and decides in the
  // page whether the server-provided similar artists are shown at all — keyed on the
  // wrong server it would ask for a set it then refuses to render.
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(infoServerId && s.audiomuseNavidromeByServer[infoServerId]),
  );

  useEffect(() => {
    if (!id || !infoArtistId || preferLocalArtist) {
      // Nobody may answer (yet). Drop a spinner left over from a route that had an
      // owner — the similar-artists Last.fm fallback waits on this flag.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setArtistInfoLoading(false);
      return;
    }
    let cancelled = false;
    setArtistInfoLoading(true);
    const infoOptions = { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined };
    (infoServerId
      ? getArtistInfoForServer(infoServerId, infoArtistId, infoOptions)
      : getArtistInfo(infoArtistId, infoOptions))
      .then(artistInfo => {
        if (!cancelled) setInfoEntry({ id, value: artistInfo ?? null });
      })
      .catch(() => {
        if (!cancelled) setInfoEntry({ id, value: null });
      })
      .finally(() => {
        if (!cancelled) setArtistInfoLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, infoServerId, infoArtistId, audiomuseNavidromeEnabled, preferLocalArtist]);

  useEffect(() => {
    // When the local index is authoritative (any selected library scope), the
    // scoped load above already provides "appears on" locally — including under
    // multi-server, where this network search is disabled. Only fall back to the
    // network search when there is no local scope to split from.
    if (!id || !artist || preferLocalArtist || browseScope.multiServer) return;
    if (serverId && browseScope.pairs.length > 0) return;
    const ownAlbumIds = new Set(albums.map(a => a.id));
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeaturedLoading(true);
    (serverId
      ? searchForServer(serverId, artist.name, { songCount: 500, artistCount: 0, albumCount: 0 })
      : search(artist.name, { songCount: 500, artistCount: 0, albumCount: 0 }))
      .catch(() => ({ songs: [], albums: [], artists: [] }))
      .then(searchResults => {
        let featuredSongs = (searchResults.songs ?? []).filter(
          song => song.artistId === id && !ownAlbumIds.has(song.albumId),
        );
        if (losslessOnly) {
          featuredSongs = featuredSongs.filter(s => isLosslessSuffix(s.suffix));
        }
        const albumMap = new Map<string, SubsonicAlbum>();
        featuredSongs.forEach(song => {
          if (!albumMap.has(song.albumId)) {
            albumMap.set(song.albumId, {
              id: song.albumId,
              name: song.album,
              // search3 children carry the album-artist credit in OpenSubsonic's
              // structured `albumArtists` / `displayAlbumArtist` (e.g. "Various
              // Artists" on compilations), not the flat `albumArtist` field — keep
              // all of them so the card resolves a name instead of "—".
              artist: song.albumArtist ?? song.displayAlbumArtist ?? '',
              artistId: '',
              artists: song.albumArtists,
              coverArt: song.coverArt,
              songCount: 1,
              duration: song.duration,
              year: song.year,
            });
          } else {
            const a = albumMap.get(song.albumId)!;
            a.songCount++;
            a.duration += song.duration;
          }
        });
        setFeaturedAlbums([...albumMap.values()]);
        setFeaturedLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist?.id, libraryBrowseScopeVersion, losslessOnly, albums, preferLocalArtist, browseScope.multiServer, serverId]);

  const info = infoEntry && infoEntry.id === id ? infoEntry.value : null;

  return {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    infoServerId, audiomuseNavidromeEnabled,
    loading, topSongsLoading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
    losslessOnly,
  };
}
