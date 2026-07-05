import { useCallback, useEffect, useState } from 'react';
import { getPlaylists } from '@/lib/api/subsonicPlaylists';
import { getArtists, getArtist } from '@/lib/api/subsonicArtists';
import { getAlbumList } from '@/lib/api/subsonicLibrary';
import { search as searchSubsonic } from '@/lib/api/subsonicSearch';
import type {
  SubsonicAlbum, SubsonicArtist, SubsonicPlaylist,
} from '@/lib/api/subsonicTypes';
import type { SourceTab } from '@/features/deviceSync/utils/deviceSyncHelpers';

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
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeTab === 'playlists' && playlists.length === 0) loadPlaylists();
    if (activeTab === 'albums'    && randomAlbums.length === 0) loadRandomAlbums();
    if (activeTab === 'artists'   && artists.length === 0)   loadArtists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Live album search with 300ms debounce
  useEffect(() => {
    if (activeTab !== 'albums') return;
    const q = search.trim();
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
