import { useEffect, useState } from 'react';
import { search } from '../api/subsonicSearch';
import { getArtist, getArtistInfo, getTopSongs } from '../api/subsonicArtists';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo, SubsonicSong,
} from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
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
  const serverId = useAuthStore(s => s.activeServerId);
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(s.activeServerId && s.audiomuseNavidromeByServer[s.activeServerId]),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

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
    setLoading(true);
    setInfoEntry(null);
    setTopSongs([]);
    setFeaturedAlbums([]);

    (async () => {
      try {
        if (losslessOnly && serverId) {
          const local = await runLocalArtistLosslessBrowse(serverId, id);
          if (cancelled) return;
          if (local) {
            const artistData = await getArtist(id).catch(() => null);
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

        const artistData = await getArtist(id);
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
          console.error(err);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [id, losslessOnly, serverId]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
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
  }, [id, audiomuseNavidromeEnabled]);

  useEffect(() => {
    if (!id || !artist) return;
    const ownAlbumIds = new Set(albums.map(a => a.id));
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
              artist: song.albumArtist ?? '',
              artistId: '',
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
  }, [artist?.id, musicLibraryFilterVersion, losslessOnly, albums]);

  const info = infoEntry && infoEntry.id === id ? infoEntry.value : null;

  return {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    loading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
    losslessOnly,
  };
}
