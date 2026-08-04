import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
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
import {
  getLibraryBrowseScope,
  hasConfiguredLibraryBrowseScope,
} from '@/lib/library/libraryBrowseScope';
import type { LibraryScopePair } from '@/lib/api/library/scopeReads';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { useLibraryScopeSyncRevision } from '@/store/offlineLocalLibrarySyncRevision';

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
  const loadGenerationRef = useRef(0);
  const favoritesOfflineEnabled = useAuthStore(s => s.favoritesOfflineEnabled);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const [searchParams] = useSearchParams();
  const detailServerId = readDetailServerId(searchParams, activeServerId);
  const invalidExplicitServer = searchParams.has('server') && !detailServerId;
  const offlineBrowseActive = useOfflineBrowseContext().active && !!detailServerId;
  const librarySyncRevision = useLibraryScopeSyncRevision(getLibraryBrowseScope().serverIds);

  useEffect(() => {
    if (!id) return;
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => loadGenerationRef.current === generation;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setAlbum(null);
    setRelatedAlbums([]);
    setStarredSongs(new Set());

    if (invalidExplicitServer) {
      setLoading(false);
      return () => {
        if (loadGenerationRef.current === generation) loadGenerationRef.current += 1;
      };
    }

    const applyAlbumPayload = (data: AlbumPayload): boolean => {
      if (!isCurrent()) return false;
      setAlbum(data);
      const initialStarred = new Set<string>();
      data.songs.forEach(s => { if (s.starred) initialStarred.add(ownedEntityKey(s)); });
      setStarredSongs(initialStarred);
      setLoading(false);
      return true;
    };

    const finishWithoutAlbum = () => {
      if (isCurrent()) setLoading(false);
    };

    const loadRelatedAlbums = async (
      serverId: string | null,
      artistId: string | undefined,
      currentAlbum: Pick<SubsonicAlbum, 'id' | 'serverId'>,
      useLocalArtist: boolean,
      localBytesOnly: boolean,
      scopes?: LibraryScopePair[],
    ) => {
      if (!artistId) return;
      try {
        if (serverId && scopes?.length) {
          const scoped = await tryLoadArtistDetailMultiScope(scopes, serverId, artistId);
          if (scoped && isCurrent()) {
            // Union: the split is the artist page's concern. "More by this artist"
            // showed compilations before and keeps doing so — narrowing it here would
            // be an unrelated behaviour change on the album page.
            setRelatedAlbums([...scoped.albums, ...scoped.appearsOnAlbums]
              .filter(a => ownedEntityKey(a) !== ownedEntityKey(currentAlbum)));
          }
          return;
        }
        if (useLocalArtist && serverId) {
          const artistLocal = localBytesOnly
            ? await loadArtistFromLocalPlayback(serverId, artistId)
            : await loadArtistFromLibraryIndex(serverId, artistId);
          if (artistLocal && isCurrent()) {
            // Related albums is an all-albums surface — union the split.
            setRelatedAlbums([...artistLocal.albums, ...artistLocal.appearsOnAlbums]
              .filter(a => ownedEntityKey(a) !== ownedEntityKey(currentAlbum)));
            return;
          }
        }
        const relatedServerId = serverId ?? detailServerId ?? activeServerId;
        if (!relatedServerId) return;
        const artistData = await resolveArtist(relatedServerId, artistId);
        if (artistData && isCurrent()) {
          setRelatedAlbums(artistData.albums.filter(a => ownedEntityKey(a) !== ownedEntityKey(currentAlbum)));
        }
      } catch (e) {
        console.error('Failed to fetch related albums', e);
      }
    };

    void (async () => {
      const browseScope = getLibraryBrowseScope();
      const browseScopeConfigured = hasConfiguredLibraryBrowseScope();
      if (offlineBrowseActive && detailServerId) {
        const local = await resolveAlbum(detailServerId, id);
        if (local) {
          if (!applyAlbumPayload(local)) return;
          await loadRelatedAlbums(
            detailServerId,
            local.album.artistId,
            local.album,
            true,
            offlineLocalBrowseEnabled(detailServerId),
          );
          return;
        }
        finishWithoutAlbum();
        return;
      }

      if (detailServerId && browseScopeConfigured && browseScope.pairs.length > 0) {
        const multi = await tryLoadAlbumDetailMultiScope(browseScope.pairs, detailServerId, id);
        if (multi) {
          if (!applyAlbumPayload(multi)) return;
          await loadRelatedAlbums(
            multi.album.serverId ?? detailServerId,
            multi.album.artistId,
            multi.album,
            true,
            false,
            browseScope.pairs,
          );
          return;
        }
        finishWithoutAlbum();
        return;
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
            if (!applyAlbumPayload(local)) return;
            await loadRelatedAlbums(detailServerId, local.album.artistId, local.album, true, false);
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
              if (!applyAlbumPayload(local)) return;
              await loadRelatedAlbums(detailServerId, local.album.artistId, local.album, true, false);
              return;
            }
          } catch { /* ignore */ }
        }
        finishWithoutAlbum();
        return;
      }

      try {
        const sid = detailServerId ?? activeServerId;
        if (!sid) {
          finishWithoutAlbum();
          return;
        }
        const data = await resolveAlbum(sid, id);
        if (!data) {
          finishWithoutAlbum();
          return;
        }
        if (!applyAlbumPayload(data)) return;
        await loadRelatedAlbums(data.album.serverId ?? sid, data.album.artistId, data.album, false, false);
      } catch {
        if (canLoadLocal && detailServerId) {
          try {
            const local = await loadAlbumFromLibraryIndex(detailServerId, id);
            if (local) {
              if (!applyAlbumPayload(local)) return;
              await loadRelatedAlbums(detailServerId, local.album.artistId, local.album, true, false);
              return;
            }
          } catch { /* ignore */ }
        }
        finishWithoutAlbum();
      }
    })();

    return () => {
      if (loadGenerationRef.current === generation) loadGenerationRef.current += 1;
    };
  }, [
    activeServerId,
    detailServerId,
    favoritesOfflineEnabled,
    id,
    invalidExplicitServer,
    libraryBrowseScopeVersion,
    librarySyncRevision,
    offlineBrowseActive,
    searchParams,
  ]);

  return { album, setAlbum, relatedAlbums, loading, starredSongs, setStarredSongs };
}
