import { useEffect, useMemo, useState } from 'react';
import { getInternetRadioStations } from '@/lib/api/subsonicRadio';
import { getStarred } from '@/lib/api/subsonicStarRating';
import type {
  InternetRadioStation, SubsonicAlbum, SubsonicArtist, SubsonicSong,
} from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { TopFavoriteArtist } from '@/features/favorites/components/TopFavoriteArtists';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { isActiveServerReachable } from '@/lib/network/activeServerReachability';
import { useOfflineBrowseContext } from '@/features/offline';
import { useOfflineBrowseReloadToken } from '@/features/offline';
import {
  loadStarredFromAllLibraryIndexes,
  loadStarredFromAllServersOnline,
} from '@/features/offline';

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

function topArtistKey(song: SubsonicSong): string {
  const artistKey = song.artistId || song.artist;
  if (!artistKey) return '';
  return song.serverId ? `${song.serverId}:${artistKey}` : artistKey;
}

export function useFavoritesData(): FavoritesDataResult {
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [radioStations, setRadioStations] = useState<InternetRadioStation[]>([]);
  const [loading, setLoading] = useState(true);

  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const servers = useAuthStore(s => s.servers);
  const { status: connStatus } = useConnectionStatus();
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const starredOverrides = usePlayerStore(s => s.starredOverrides);

  useEffect(() => {
    let cancelled = false;

    const applyStarred = (starred: {
      albums: SubsonicAlbum[];
      artists: SubsonicArtist[];
      songs: SubsonicSong[];
    }) => {
      if (cancelled) return;
      setAlbums(starred.albums);
      setArtists(starred.artists);
      setSongs(starred.songs);
    };

    const loadRadioFavorites = async () => {
      if (!isActiveServerReachable()) return;
      try {
        const favIds = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
        if (favIds.size === 0) return;
        const all = await getInternetRadioStations();
        if (!cancelled) {
          setRadioStations(all.filter(s => favIds.has(s.id)));
        }
      } catch { /* ignore */ }
    };

    const loadAll = async () => {
      setLoading(true);

      if (favoritesOfflineEnabled) {
        try {
          applyStarred(await loadStarredFromAllLibraryIndexes(offlineBrowseActive));
        } catch { /* ignore */ }
        if (!cancelled) setLoading(false);

        if (connStatus === 'connected' && isActiveServerReachable()) {
          try {
            applyStarred(await loadStarredFromAllServersOnline());
          } catch { /* keep library snapshot */ }
        }
      } else {
        if (connStatus === 'connected' && isActiveServerReachable()) {
          const [starredResult] = await Promise.allSettled([getStarred()]);
          if (starredResult.status === 'fulfilled') {
            applyStarred(starredResult.value);
          }
        }
        if (!cancelled) setLoading(false);
      }

      void loadRadioFavorites();
    };

    void loadAll();
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion, connStatus, favoritesOfflineEnabled, offlineBrowseActive, offlineBrowseReloadTs, servers]);

  const topFavoriteArtists = useMemo<TopFavoriteArtist[]>(() => {
    const counts = new Map<string, TopFavoriteArtist>();
    for (const s of songs) {
      if (starredOverrides[s.id] === false) continue;
      const key = topArtistKey(s);
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
          serverId: s.serverId,
          artistId: s.artistId || s.artist,
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
