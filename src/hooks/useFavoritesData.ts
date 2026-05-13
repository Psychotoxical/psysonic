import { useEffect, useMemo, useState } from 'react';
import { getInternetRadioStations } from '../api/subsonicRadio';
import { getStarred } from '../api/subsonicStarRating';
import type {
  InternetRadioStation, SubsonicAlbum, SubsonicArtist, SubsonicSong,
} from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import type { TopFavoriteArtist } from '../components/favorites/TopFavoriteArtists';

export interface FavoritesDataResult {
  albums: SubsonicAlbum[];
  artists: SubsonicArtist[];
  songs: SubsonicSong[];
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  radioStations: InternetRadioStation[];
  setRadioStations: React.Dispatch<React.SetStateAction<InternetRadioStation[]>>;
  loading: boolean;
  topFavoriteArtists: TopFavoriteArtist[];
  unfavoriteStation: (id: string) => void;
}

export function useFavoritesData(): FavoritesDataResult {
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [radioStations, setRadioStations] = useState<InternetRadioStation[]>([]);
  const [loading, setLoading] = useState(true);

  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);

  useEffect(() => {
    const loadAll = async () => {
      const [starredResult] = await Promise.allSettled([
        getStarred(),
      ]);
      if (starredResult.status === 'fulfilled') {
        setAlbums(starredResult.value.albums);
        setArtists(starredResult.value.artists);
        setSongs(starredResult.value.songs);
      }

      // Radio favorites: read IDs from localStorage, fetch all stations, filter
      try {
        const favIds = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
        if (favIds.size > 0) {
          const all = await getInternetRadioStations();
          setRadioStations(all.filter(s => favIds.has(s.id)));
        }
      } catch { /* ignore */ }

      setLoading(false);
    };
    loadAll();
  }, [musicLibraryFilterVersion]);

  // ── Top Favorite Artists aggregated from favorited songs ─────────────
  const topFavoriteArtists = useMemo<TopFavoriteArtist[]>(() => {
    const counts = new Map<string, TopFavoriteArtist>();
    for (const s of songs) {
      if (starredOverrides[s.id] === false) continue;
      const key = s.artistId || s.artist;
      if (!key) continue;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          id: key,
          name: s.artist || key,
          count: 1,
          coverArtId: s.artistId || '',
        });
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [songs, starredOverrides]);

  function unfavoriteStation(id: string) {
    setRadioStations(prev => prev.filter(s => s.id !== id));
    try {
      const next = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
      next.delete(id);
      localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...next]));
    } catch { /* ignore */ }
  }

  return {
    albums, artists, songs, setSongs, radioStations, setRadioStations,
    loading, topFavoriteArtists, unfavoriteStation,
  };
}
