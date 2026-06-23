import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';
import {
  loadAlbumFromLibraryIndex,
  loadArtistFromLibraryIndex,
} from '../utils/offline/offlineLibraryIndexLoad';
import {
  resolveAlbum,
  resolveArtist,
  type ResolvedAlbum,
} from '../utils/offline/offlineMediaResolve';
import { useOfflineBrowseContext } from './useOfflineBrowseContext';
import {
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
} from '../utils/offline/offlineLocalBrowse';
import { readDetailServerId } from '../utils/navigation/detailServerScope';
import {
  shouldAttemptSubsonicForActiveServer,
  shouldAttemptSubsonicForServer,
} from '../utils/network/subsonicNetworkGuard';

type AlbumPayload = ResolvedAlbum;

interface UseAlbumDetailDataResult {
  album: AlbumPayload | null;
  setAlbum: React.Dispatch<React.SetStateAction<AlbumPayload | null>>;
  relatedAlbums: SubsonicAlbum[];
  loading: boolean;
  isStarred: boolean;
  setIsStarred: (v: boolean) => void;
  starredSongs: Set<string>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * Load an album payload by id, then resolve the artist's other albums in
 * a follow-up call so the related-albums grid can render without blocking
 * the initial paint.
 */
export function useAlbumDetailData(id: string | undefined): UseAlbumDetailDataResult {
  const [album, setAlbum] = useState<AlbumPayload | null>(null);
  const [relatedAlbums, setRelatedAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [isStarred, setIsStarred] = useState(false);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const [searchParams] = useSearchParams();
  const detailServerId = readDetailServerId(searchParams, activeServerId);
  const offlineBrowseActive = useOfflineBrowseContext().active && !!detailServerId;

  useEffect(() => {
    if (!id) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setRelatedAlbums([]);

    const applyAlbumPayload = (data: AlbumPayload) => {
      setAlbum(data);
      setIsStarred(!!data.album.starred);
      const initialStarred = new Set<string>();
      data.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
      setStarredSongs(initialStarred);
      setLoading(false);
    };

    const loadRelatedAlbums = async (
      serverId: string | null,
      artistId: string | undefined,
      useLocalArtist: boolean,
      localBytesOnly: boolean,
    ) => {
      if (!artistId) return;
      try {
        if (useLocalArtist && serverId) {
          const artistLocal = localBytesOnly
            ? await loadArtistFromLocalPlayback(serverId, artistId)
            : await loadArtistFromLibraryIndex(serverId, artistId);
          if (artistLocal) {
            setRelatedAlbums(artistLocal.albums.filter(a => a.id !== id));
            return;
          }
        }
        const relatedServerId = serverId ?? detailServerId ?? activeServerId;
        if (!relatedServerId) return;
        const artistData = await resolveArtist(relatedServerId, artistId);
        if (artistData) {
          setRelatedAlbums(artistData.albums.filter(a => a.id !== id));
        }
      } catch (e) {
        console.error('Failed to fetch related albums', e);
      }
    };

    const libraryFirst = favoritesOfflineEnabled && !!detailServerId;

    void (async () => {
      if (offlineBrowseActive && detailServerId) {
        const local = await resolveAlbum(detailServerId, id);
        if (local) {
          applyAlbumPayload(local);
          await loadRelatedAlbums(
            detailServerId,
            local.album.artistId,
            true,
            offlineLocalBrowseEnabled(detailServerId),
          );
          return;
        }
        setLoading(false);
        return;
      }

      if (libraryFirst && detailServerId) {
        try {
          const local = await resolveAlbum(detailServerId, id);
          if (local) {
            applyAlbumPayload(local);
            await loadRelatedAlbums(detailServerId, local.album.artistId, true, false);
            return;
          }
        } catch { /* fall through */ }
      }

      const detailNetworkAllowed = detailServerId
        ? shouldAttemptSubsonicForServer(detailServerId)
        : shouldAttemptSubsonicForActiveServer();

      if (!detailNetworkAllowed) {
        if (favoritesOfflineEnabled && detailServerId) {
          try {
            const local = await resolveAlbum(detailServerId, id);
            if (local) {
              applyAlbumPayload(local);
              await loadRelatedAlbums(detailServerId, local.album.artistId, true, false);
              return;
            }
          } catch { /* ignore */ }
        }
        setLoading(false);
        return;
      }

      try {
        const sid = detailServerId ?? activeServerId;
        if (!sid) {
          setLoading(false);
          return;
        }
        const data = await resolveAlbum(sid, id);
        if (!data) {
          setLoading(false);
          return;
        }
        applyAlbumPayload(data);
        await loadRelatedAlbums(detailServerId, data.album.artistId, false, false);
      } catch {
        if (favoritesOfflineEnabled && detailServerId) {
          try {
            const local = await loadAlbumFromLibraryIndex(detailServerId, id);
            if (local) {
              applyAlbumPayload(local);
              await loadRelatedAlbums(detailServerId, local.album.artistId, true, false);
              return;
            }
          } catch { /* ignore */ }
        }
        setLoading(false);
      }
    })();
  }, [activeServerId, detailServerId, favoritesOfflineEnabled, id, offlineBrowseActive, searchParams]);

  return { album, setAlbum, relatedAlbums, loading, isStarred, setIsStarred, starredSongs, setStarredSongs };
}
