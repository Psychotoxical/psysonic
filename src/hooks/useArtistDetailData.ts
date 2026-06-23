import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { search } from '../api/subsonicSearch';
import { getArtist, getArtistForServer, getArtistInfo, getTopSongs } from '../api/subsonicArtists';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo, SubsonicSong,
} from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { useConnectionStatus } from './useConnectionStatus';
import { loadArtistFromLibraryIndex } from '../utils/offline/offlineLibraryIndexLoad';
import { useOfflineBrowseContext } from './useOfflineBrowseContext';
import { loadArtistFromLocalPlayback, offlineLocalBrowseEnabled } from '../utils/offline/offlineLocalBrowse';
import { readDetailServerId } from '../utils/navigation/detailServerScope';
import { runLocalArtistLosslessBrowse } from '../utils/library/browseTextSearch';
import { isLosslessSuffix } from '../utils/library/losslessFormats';

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
  featuredAlbums: SubsonicAlbum[];
  loading: boolean;
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

export function useArtistDetailData(
  id: string | undefined,
  options: UseArtistDetailDataOptions = {},
): ArtistDetailDataResult {
  const losslessOnly = options.losslessOnly ?? false;
  const activeServerId = useAuthStore(s => s.activeServerId);
  const [searchParams] = useSearchParams();
  const serverId = readDetailServerId(searchParams, activeServerId);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const { status: connStatus } = useConnectionStatus();
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(serverId && s.audiomuseNavidromeByServer[serverId]),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const offlineBrowseActive = useOfflineBrowseContext().active && !!serverId;
  const preferLocalBytesOnly = offlineBrowseActive && offlineLocalBrowseEnabled(serverId);
  const preferLocalArtist = preferLocalBytesOnly
    || (connStatus === 'disconnected' && favoritesOfflineEnabled && !!serverId);

  const [artist, setArtist] = useState<SubsonicArtist | null>(null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [featuredAlbums, setFeaturedAlbums] = useState<SubsonicAlbum[]>([]);
  const [topSongs, setTopSongs] = useState<SubsonicSong[]>([]);
  const [infoEntry, setInfoEntry] = useState<{ id: string; value: SubsonicArtistInfo | null } | null>(null);
  const [loading, setLoading] = useState(true);
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
    setFeaturedAlbums([]);

    (async () => {
      try {
        if (offlineBrowseActive && !preferLocalBytesOnly) {
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

        const songsData = await getTopSongs(artistData.artist.name).catch(() => [] as SubsonicSong[]);
        if (cancelled) return;
        let nextSongs = songsData ?? [];
        if (losslessOnly) {
          ({ albums: nextAlbums, songs: nextSongs } = filterNetworkArtistToLossless(nextAlbums, nextSongs));
        }
        setAlbums(nextAlbums);
        setTopSongs(nextSongs);
      } catch (err) {
        if (!cancelled) {
          if (preferLocalArtist && serverId && id) {
            try {
              const local = preferLocalBytesOnly
                ? await loadArtistFromLocalPlayback(serverId, id)
                : await loadArtistFromLibraryIndex(serverId, id);
              if (cancelled) return;
              if (local) {
                setArtist(local.artist);
                setIsStarred(!!local.artist.starred);
                setAlbums(local.albums);
                setTopSongs([]);
                setLoading(false);
                return;
              }
            } catch { /* ignore */ }
          }
          console.error(err);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [id, losslessOnly, serverId, offlineBrowseActive, preferLocalArtist, preferLocalBytesOnly, searchParams]);

  useEffect(() => {
    if (!id || preferLocalArtist) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArtistInfoLoading(true);
    getArtistInfo(id, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
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
  }, [id, audiomuseNavidromeEnabled, preferLocalArtist]);

  useEffect(() => {
    if (!id || !artist || preferLocalArtist) return;
    const ownAlbumIds = new Set(albums.map(a => a.id));
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeaturedLoading(true);
    search(artist.name, { songCount: 500, artistCount: 0, albumCount: 0 })
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
  }, [artist?.id, musicLibraryFilterVersion, losslessOnly, albums, preferLocalArtist]);

  const info = infoEntry && infoEntry.id === id ? infoEntry.value : null;

  return {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    loading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
    losslessOnly,
  };
}
