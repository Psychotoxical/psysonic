import { useEffect, useState } from 'react';
import { search } from '../api/subsonicSearch';
import { getArtist, getArtistInfo, getTopSongs } from '../api/subsonicArtists';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicArtistInfo, SubsonicSong,
} from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';

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
}

export function useArtistDetailData(id: string | undefined): ArtistDetailDataResult {
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(s.activeServerId && s.audiomuseNavidromeByServer[s.activeServerId]),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  const [artist, setArtist] = useState<SubsonicArtist | null>(null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [featuredAlbums, setFeaturedAlbums] = useState<SubsonicAlbum[]>([]);
  const [topSongs, setTopSongs] = useState<SubsonicSong[]>([]);
  const [info, setInfo] = useState<SubsonicArtistInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [artistInfoLoading, setArtistInfoLoading] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setInfo(null);
    setTopSongs([]);
    setFeaturedAlbums([]);
    getArtist(id).then(artistData => {
      if (cancelled) return;
      setArtist(artistData.artist);
      setAlbums(artistData.albums);
      setIsStarred(!!artistData.artist.starred);
      // Render the page immediately from local data
      setLoading(false);

      getTopSongs(artistData.artist.name).then(songsData => {
        if (!cancelled) setTopSongs(songsData ?? []);
      }).catch(() => {});
    }).catch(err => {
      if (!cancelled) { console.error(err); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setArtistInfoLoading(true);
    getArtistInfo(id, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(artistInfo => {
        if (!cancelled) setInfo(artistInfo ?? null);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      })
      .finally(() => {
        if (!cancelled) setArtistInfoLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, audiomuseNavidromeEnabled]);

  // "Also Featured On" — loaded in background after main content renders
  useEffect(() => {
    if (!id || !artist) return;
    const ownAlbumIds = new Set(albums.map(a => a.id));
    setFeaturedLoading(true);
    search(artist.name, { songCount: 500, artistCount: 0, albumCount: 0 })
      .catch(() => ({ songs: [], albums: [], artists: [] }))
      .then(searchResults => {
        const featuredSongs = (searchResults.songs ?? []).filter(
          song => song.artistId === id && !ownAlbumIds.has(song.albumId)
        );
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
  }, [artist?.id, musicLibraryFilterVersion]);

  return {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    loading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
  };
}
