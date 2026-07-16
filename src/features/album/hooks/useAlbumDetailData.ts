import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import {
  loadAlbumFromLibraryIndex,
  loadArtistFromLibraryIndex,
} from '@/features/offline';
import {
  resolveAlbum,
  resolveArtist,
  type ResolvedAlbum,
} from '@/features/offline';
import { useOfflineBrowseContext } from '@/features/offline';
import {
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
} from '@/features/offline';
import { readDetailServerId } from '@/lib/navigation/detailServerScope';
import { libraryIsReady } from '@/lib/library/libraryReady';
import {
  shouldAttemptSubsonicForActiveServer,
  shouldAttemptSubsonicForServer,
} from '@/lib/network/subsonicNetworkGuard';
import { tryLoadAlbumDetailMultiScope } from '@/features/album/hooks/loadAlbumDetailMultiScope';
import { tryLoadArtistDetailMultiScope } from '@/lib/library/loadArtistDetailMultiScope';
import { useBrowseLibraryScope } from '@/store/useBrowseLibraryScope';

type AlbumPayload = ResolvedAlbum;

interface UseAlbumDetailDataResult {
  album: AlbumPayload | null;
  setAlbum: React.Dispatch<React.SetStateAction<AlbumPayload | null>>;
  relatedAlbums: SubsonicAlbum[];
  loading: boolean;
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
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const musicLibrarySelectionByServer = useAuthStore(s => s.musicLibrarySelectionByServer);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const [searchParams] = useSearchParams();
  const detailServerId = readDetailServerId(searchParams, activeServerId);
  const browseScope = useBrowseLibraryScope();
  const offlineBrowseActive = useOfflineBrowseContext().active && !!detailServerId;

  useEffect(() => {
    if (!id) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setRelatedAlbums([]);

    const applyAlbumPayload = (data: AlbumPayload) => {
      setAlbum(data);
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
        if (browseScope.multiServer) {
          const scoped = await tryLoadArtistDetailMultiScope(
            serverId ?? browseScope.anchorServerId,
            artistId,
            browseScope.pairs,
          );
          if (scoped) setRelatedAlbums(scoped.albums.filter(a => a.id !== id));
          return;
        }
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

      if (detailServerId && browseScope.pairs.length > 0) {
        const multi = await tryLoadAlbumDetailMultiScope(detailServerId, id, browseScope.pairs);
        if (multi) {
          applyAlbumPayload(multi);
          await loadRelatedAlbums(detailServerId, multi.album.artistId, true, false);
          return;
        }
        if (browseScope.multiServer) {
          setLoading(false);
          return;
        }
      }

      // Index-first when the local SQLite index is ready, not only when the
      // favorites-offline toggle is on — album detail then opens from SQLite
      // (and offline) with the same genres genre browse derives.
      const indexReady = !!detailServerId && await libraryIsReady(detailServerId);
      const canLoadLocal = (favoritesOfflineEnabled || indexReady) && !!detailServerId;

      if (canLoadLocal && detailServerId) {
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
        if (canLoadLocal && detailServerId) {
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
        if (canLoadLocal && detailServerId) {
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
  }, [
    activeServerId,
    browseScope.anchorServerId,
    browseScope.fingerprint,
    browseScope.multiServer,
    browseScope.pairs,
    detailServerId,
    favoritesOfflineEnabled,
    id,
    musicLibraryFilterVersion,
    musicLibrarySelectionByServer,
    offlineBrowseActive,
    searchParams,
  ]);

  return { album, setAlbum, relatedAlbums, loading, starredSongs, setStarredSongs };
}
