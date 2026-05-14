import { useCallback, useEffect, useState } from 'react';
import { getPlaylists } from '../api/subsonicPlaylists';
import { getArtists, getArtist } from '../api/subsonicArtists';
import { getAlbumList } from '../api/subsonicLibrary';
import { search as searchSubsonic } from '../api/subsonicSearch';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicPlaylist,
} from '../api/subsonicTypes';
import type { SourceTab } from '../utils/deviceSync/deviceSyncHelpers';

export interface DeviceSyncBrowserResult {
  playlists: SubsonicPlaylist[];
  randomAlbums: SubsonicAlbum[];
  albumSearchResults: SubsonicAlbum[];
  albumSearchLoading: boolean;
  artists: SubsonicArtist[];
  loadingBrowser: boolean;
  expandedArtistIds: Set<string>;
  artistAlbumsMap: Map<string, SubsonicAlbum[]>;
  loadingArtistIds: Set<string>;
  toggleArtistExpand: (artistId: string) => Promise<void>;
}

export function useDeviceSyncBrowser(
  activeTab: SourceTab,
  search: string,
  resetSearch: () => void,
): DeviceSyncBrowserResult {
  const [playlists, setPlaylists]           = useState<SubsonicPlaylist[]>([]);
  const [randomAlbums, setRandomAlbums]     = useState<SubsonicAlbum[]>([]);
  const [albumSearchResults, setAlbumSearchResults] = useState<SubsonicAlbum[]>([]);
  const [albumSearchLoading, setAlbumSearchLoading] = useState(false);
  const [artists, setArtists]               = useState<SubsonicArtist[]>([]);
  const [loadingBrowser, setLoadingBrowser] = useState(false);
  const [expandedArtistIds, setExpandedArtistIds] = useState<Set<string>>(new Set());
  const [artistAlbumsMap, setArtistAlbumsMap]     = useState<Map<string, SubsonicAlbum[]>>(new Map());
  const [loadingArtistIds, setLoadingArtistIds]   = useState<Set<string>>(new Set());

  const loadPlaylists = useCallback(async () => {
    setLoadingBrowser(true);
    try { setPlaylists(await getPlaylists()); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);
  const loadRandomAlbums = useCallback(async () => {
    setLoadingBrowser(true);
    try { setRandomAlbums(await getAlbumList('random', 10)); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);
  const loadArtists = useCallback(async () => {
    setLoadingBrowser(true);
    try { setArtists(await getArtists()); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);

  useEffect(() => {
    resetSearch();
    if (activeTab === 'playlists' && playlists.length === 0) loadPlaylists();
    if (activeTab === 'albums'    && randomAlbums.length === 0) loadRandomAlbums();
    if (activeTab === 'artists'   && artists.length === 0)   loadArtists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Live album search with 300ms debounce
  useEffect(() => {
    if (activeTab !== 'albums') return;
    const q = search.trim();
    if (!q) { setAlbumSearchResults([]); return; }
    setAlbumSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { albums } = await searchSubsonic(q, { albumCount: 20, artistCount: 0, songCount: 0 });
        setAlbumSearchResults(albums);
      } catch {
        setAlbumSearchResults([]);
      } finally {
        setAlbumSearchLoading(false);
      }
    }, 300);
    return () => { clearTimeout(timer); setAlbumSearchLoading(false); };
  }, [search, activeTab]);

  const toggleArtistExpand = useCallback(async (artistId: string) => {
    setExpandedArtistIds(prev => {
      const next = new Set(prev);
      if (next.has(artistId)) { next.delete(artistId); return next; }
      next.add(artistId);
      return next;
    });
    if (!artistAlbumsMap.has(artistId)) {
      setLoadingArtistIds(prev => new Set(prev).add(artistId));
      try {
        const { albums } = await getArtist(artistId);
        setArtistAlbumsMap(prev => new Map(prev).set(artistId, albums));
      } finally {
        setLoadingArtistIds(prev => { const n = new Set(prev); n.delete(artistId); return n; });
      }
    }
  }, [artistAlbumsMap]);

  return {
    playlists, randomAlbums, albumSearchResults, albumSearchLoading,
    artists, loadingBrowser,
    expandedArtistIds, artistAlbumsMap, loadingArtistIds,
    toggleArtistExpand,
  };
}
