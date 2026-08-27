import { useEffect, useMemo, useRef, useState } from 'react';
import { getInternetRadioStationsForServersSettled } from '@/lib/api/subsonicRadio';
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
import {
  beginFavoritesBrowseTrace,
  emitFavoritesBrowseDebug,
  favoritesBrowseTimed,
} from '@/lib/library/favoritesBrowseDebug';
import { ownedOverrideValue } from '@/lib/util/ownedEntityKey';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import {
  migrateRadioStationKeys,
  radioStationKey,
} from '@/features/radio';
import { navidromeCanonicalBootstrapIsActive } from '@/lib/server/navidromeCanonicalCheckpointStatus';

export interface FavoritesDataResult {
  albums: SubsonicAlbum[];
  artists: SubsonicArtist[];
  songs: SubsonicSong[];
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  radioStations: InternetRadioStation[];
  setRadioStations: React.Dispatch<React.SetStateAction<InternetRadioStation[]>>;
  loading: boolean;
  topFavoriteArtists: TopFavoriteArtist[];
  unfavoriteStation: (station: InternetRadioStation) => void;
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
  const radioMutationGenerationRef = useRef(0);

  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const servers = useAuthStore(s => s.servers);
  const { status: connStatus } = useConnectionStatus();
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const offlineBrowseReloadTs = useOfflineBrowseReloadToken();
  const unavailableServerIds = useUnavailableServerIds();
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
      emitFavoritesBrowseDebug('starred_snapshot_applied', {
        albumCount: starred.albums.length,
        artistCount: starred.artists.length,
        songCount: starred.songs.length,
      });
    };

    const loadRadioFavorites = async () => {
      try {
        const mutationGeneration = radioMutationGenerationRef.current;
        const favIds = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
        if (favIds.size === 0) return;
        const serverIds = deriveEffectiveLibraryBrowseServerIds({
          servers,
          activeServerId,
          libraryBrowseServerIds,
        }, unavailableServerIds);
        const result = await favoritesBrowseTimed('radio_stations', () => (
          getInternetRadioStationsForServersSettled(serverIds)
        ), {
          favoriteStationCount: favIds.size,
        });
        if (!cancelled && mutationGeneration === radioMutationGenerationRef.current) {
          const failed = new Set(result.failedServerIds);
          setRadioStations(previous => {
            const available = serverIds.flatMap(serverId => failed.has(serverId)
              ? previous.filter(station => station.serverId === serverId)
              : result.stations.filter(station => station.serverId === serverId));
            const migrated = new Set(migrateRadioStationKeys(
              [...favIds],
              available,
            ));
            if (!navidromeCanonicalBootstrapIsActive()) {
              localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...migrated]));
            }
            return available.filter(station => migrated.has(radioStationKey(station)));
          });
          emitFavoritesBrowseDebug('radio_favorites_applied', {
            stationCount: result.stations.filter(station => (
              favIds.has(radioStationKey(station)) || favIds.has(station.id)
            )).length,
          });
        }
      } catch { /* ignore */ }
    };

    const loadAll = async () => {
      setLoading(true);
      beginFavoritesBrowseTrace({
        favoritesOfflineEnabled,
        offlineBrowseActive,
        connectionStatus: connStatus,
        activeServerReachable: isActiveServerReachable(),
        serverCount: servers.length,
      });

      if (favoritesOfflineEnabled) {
        try {
          applyStarred(await favoritesBrowseTimed(
            'library_index_snapshot',
            () => loadStarredFromAllLibraryIndexes(offlineBrowseActive),
          ));
        } catch { /* ignore */ }
        if (cancelled) return;
        if (!cancelled) setLoading(false);

        if (connStatus === 'connected' && isActiveServerReachable()) {
          try {
            applyStarred(await favoritesBrowseTimed(
              'server_starred_refresh',
              () => loadStarredFromAllServersOnline(),
            ));
          } catch { /* keep library snapshot */ }
        }
      } else {
        if (connStatus === 'connected' && isActiveServerReachable()) {
          const [starredResult] = await Promise.allSettled([
            favoritesBrowseTimed('server_starred', () => getStarred()),
          ]);
          if (starredResult.status === 'fulfilled') {
            applyStarred(starredResult.value);
          }
        }
        if (!cancelled) setLoading(false);
      }

      void loadRadioFavorites();
      emitFavoritesBrowseDebug('load_complete');
    };

    void loadAll();
    return () => { cancelled = true; };
  }, [
    musicLibraryFilterVersion,
    libraryBrowseScopeVersion,
    connStatus,
    favoritesOfflineEnabled,
    offlineBrowseActive,
    offlineBrowseReloadTs,
    activeServerId,
    libraryBrowseServerIds,
    servers,
    unavailableServerIds,
  ]);

  const topFavoriteArtists = useMemo<TopFavoriteArtist[]>(() => {
    const counts = new Map<string, TopFavoriteArtist>();
    for (const s of songs) {
      if (ownedOverrideValue(starredOverrides, s) === false) continue;
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

  function unfavoriteStation(station: InternetRadioStation) {
    radioMutationGenerationRef.current += 1;
    const key = radioStationKey(station);
    setRadioStations(prev => prev.filter(candidate => radioStationKey(candidate) !== key));
    try {
      const next = new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'));
      next.delete(key);
      next.delete(station.id);
      if (!navidromeCanonicalBootstrapIsActive()) {
        localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...next]));
      }
    } catch { /* ignore */ }
  }

  return {
    albums, artists, songs, setSongs, radioStations, setRadioStations,
    loading, topFavoriteArtists, unfavoriteStation,
  };
}
