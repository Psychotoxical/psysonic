import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  libraryScopeAlbumDetail,
  libraryScopeArtistDetail,
  libraryScopeListArtists,
} from '@/lib/api/library/scopeReads';
import type { SubsonicDirectoryEntry } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import {
  albumDtoToFolderEntry, artistDtoToFolderEntry, folderBrowserEntryKey, selectedFolderBrowserEntry,
  trackDtoToFolderEntry,
  type Column, type NavPos,
} from '@/features/folderBrowser/utils/folderBrowserHelpers';

let persistedPlayingPathIds: string[] = [];

interface Args {
  columns: Column[];
  currentTrack: Track | null;
  isPlaying: boolean;
  setColumns: React.Dispatch<React.SetStateAction<Column[]>>;
  setKeyboardPos: React.Dispatch<React.SetStateAction<NavPos | null>>;
}

interface Result {
  playingPathIds: string[];
  setPlayingPathIds: React.Dispatch<React.SetStateAction<string[]>>;
  isSelectedPathForCurrentTrack: boolean;
}

export function useFolderBrowserNowPlayingPath({
  columns, currentTrack, isPlaying, setColumns, setKeyboardPos,
}: Args): Result {
  const [playingPathIds, setPlayingPathIds] = useState<string[]>(persistedPlayingPathIds);
  const [playingPathServerId, setPlayingPathServerId] = useState<string | null>(null);
  const autoResolvedTrackRef = useRef<string | null>(null);
  const prevTrackKeyRef = useRef<string | null>(null);
  const lastHotkeyRevealTsRef = useRef<number | null>(null);
  const location = useLocation();

  const trackIdentity = currentTrack ? folderBrowserEntryKey(currentTrack) : null;

  useEffect(() => {
    if (!currentTrack?.id) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlayingPathIds([]);
      setPlayingPathServerId(null);
      return;
    }
    setPlayingPathIds(prev => (prev[prev.length - 1] === trackIdentity ? prev : []));
    setPlayingPathServerId(prev => prev === currentTrack.serverId ? prev : null);
  }, [currentTrack?.id, currentTrack?.serverId, trackIdentity]);

  useEffect(() => {
    if (!isPlaying || !currentTrack?.id) return;
    const selectedChain = columns
      .map(selectedFolderBrowserEntry)
      .filter((entry): entry is SubsonicDirectoryEntry => !!entry)
      .map(folderBrowserEntryKey);
    if (selectedChain.length === 0) return;

    const leafColumn = [...columns].reverse().find(c => c.selectedKey);
    const leafItem = leafColumn && selectedFolderBrowserEntry(leafColumn);
    if (!leafColumn || !leafItem || leafItem.isDir || folderBrowserEntryKey(leafItem) !== trackIdentity) return;

    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlayingPathIds(prev => {
      if (
        prev.length === selectedChain.length &&
        prev.every((id, idx) => id === selectedChain[idx])
      ) {
        return prev;
      }
      return selectedChain;
    });
    setPlayingPathServerId(leafItem.serverId ?? null);
  }, [columns, currentTrack?.id, currentTrack?.serverId, isPlaying, trackIdentity]);

  useEffect(() => {
    persistedPlayingPathIds = playingPathIds;
  }, [playingPathIds]);

  const resolveColumnsForTrack = useCallback(async (
    track: Track,
    roots: SubsonicDirectoryEntry[],
  ): Promise<Column[] | null> => {
    for (const root of roots) {
      if (!root.serverId || (track.serverId && root.serverId !== track.serverId)) continue;
      const scopes = [{ serverId: root.serverId, libraryId: root.sourceId ?? root.id }];
      let indexes: SubsonicDirectoryEntry[];
      try {
        indexes = (await libraryScopeListArtists(root.serverId, { scopes, sort: 'name', limit: 10_000 }))
          .map(artistDtoToFolderEntry);
      } catch {
        continue;
      }

      const artistEntry =
        indexes.find(it =>
          it.isDir && !!track.artistId && it.id === track.artistId &&
          (!track.serverId || !it.serverId || it.serverId === track.serverId),
        ) ??
        indexes.find(it =>
          it.isDir && it.title === track.artist &&
          (!track.serverId || !it.serverId || it.serverId === track.serverId),
        );
      if (!artistEntry) continue;

      let artistChildren: SubsonicDirectoryEntry[];
      try {
        const detail = await libraryScopeArtistDetail(root.serverId, {
          scopes,
          artistId: artistEntry.id,
          serverId: root.serverId,
          includeTracks: false,
        });
        // Must include appears-on: revealing a track played off a compilation has to
        // find that album under the artist, otherwise the reveal silently gives up.
        artistChildren = [...detail.albums, ...detail.appearsOnAlbums]
          .map(albumDtoToFolderEntry);
      } catch {
        continue;
      }

      const albumEntry = artistChildren.find(it =>
        it.isDir &&
        (
          (!!track.albumId && (it.albumId === track.albumId || it.id === track.albumId)) ||
          (!!track.album && (it.album === track.album || it.title === track.album))
        ) &&
        (!track.serverId || !it.serverId || it.serverId === track.serverId),
      );
      if (!albumEntry) continue;

      let albumChildren: SubsonicDirectoryEntry[];
      try {
        albumChildren = (await libraryScopeAlbumDetail(root.serverId, {
          scopes,
          albumId: albumEntry.id,
          serverId: root.serverId,
        })).tracks.map(trackDtoToFolderEntry);
      } catch {
        continue;
      }
      const songEntry = albumChildren.find(it =>
        !it.isDir && it.id === track.id &&
        (!track.serverId || !it.serverId || it.serverId === track.serverId),
      );
      if (!songEntry) continue;

      return [
        { id: 'root', name: '', items: roots, selectedKey: folderBrowserEntryKey(root), loading: false, error: false, kind: 'roots' },
        { id: root.id, name: root.title, items: indexes, selectedKey: folderBrowserEntryKey(artistEntry), loading: false, error: false, kind: 'artists', serverId: root.serverId, scopes },
        { id: artistEntry.id, name: artistEntry.title, items: artistChildren, selectedKey: folderBrowserEntryKey(albumEntry), loading: false, error: false, kind: 'albums', serverId: root.serverId, scopes },
        { id: albumEntry.id, name: albumEntry.title, items: albumChildren, selectedKey: folderBrowserEntryKey(songEntry), loading: false, error: false, kind: 'tracks', serverId: root.serverId, scopes },
      ];
    }
    return null;
  }, []);

  useEffect(() => {
    if (!currentTrack?.id) {
      autoResolvedTrackRef.current = null;
      return;
    }

    const hotkeyRevealTs = (location.state as { folderBrowserRevealTs?: number } | null)?.folderBrowserRevealTs ?? null;
    const hotkeyRevealRequested = hotkeyRevealTs !== null && hotkeyRevealTs !== lastHotkeyRevealTsRef.current;
    const forceReveal = hotkeyRevealRequested;
    if (autoResolvedTrackRef.current === trackIdentity && !forceReveal) return;

    const rootCol = columns[0];
    if (!rootCol || rootCol.loading || rootCol.error || rootCol.items.length === 0) return;

    const selectedLeafColumn = [...columns].reverse().find(c => c.selectedKey);
    const selectedLeafEntry = selectedLeafColumn && selectedFolderBrowserEntry(selectedLeafColumn);
    const selectedLeafKey = selectedLeafEntry ? folderBrowserEntryKey(selectedLeafEntry) : null;
    const wasOnPreviousTrackPath = !!prevTrackKeyRef.current && selectedLeafKey === prevTrackKeyRef.current;
    if (selectedLeafKey === trackIdentity) {
      autoResolvedTrackRef.current = trackIdentity;
      if (hotkeyRevealRequested) {
        lastHotkeyRevealTsRef.current = hotkeyRevealTs;
      }
      return;
    }
    if (!forceReveal && !wasOnPreviousTrackPath) return;

    let cancelled = false;
    resolveColumnsForTrack(currentTrack, rootCol.items).then((resolved) => {
      if (cancelled || !resolved) return;
      setColumns(resolved);
      const path = resolved.map(c => c.selectedKey).filter((key): key is string => !!key);
      setPlayingPathIds(path);
      setPlayingPathServerId(currentTrack.serverId ?? null);
      const leafColIndex = resolved.length - 1;
      const leafRowIndex = resolved[leafColIndex].items.findIndex(it => folderBrowserEntryKey(it) === trackIdentity);
      if (leafRowIndex >= 0) setKeyboardPos({ colIndex: leafColIndex, rowIndex: leafRowIndex });
      autoResolvedTrackRef.current = trackIdentity;
      if (hotkeyRevealRequested) {
        lastHotkeyRevealTsRef.current = hotkeyRevealTs;
      }
    });

    return () => { cancelled = true; };
  }, [columns, currentTrack, trackIdentity, resolveColumnsForTrack, location.state, setColumns, setKeyboardPos]);

  useEffect(() => {
    prevTrackKeyRef.current = trackIdentity;
  }, [trackIdentity]);

  const isSelectedPathForCurrentTrack =
    isPlaying && !!currentTrack && playingPathServerId === currentTrack.serverId && playingPathIds[playingPathIds.length - 1] === trackIdentity;

  return {
    playingPathIds,
    setPlayingPathIds,
    isSelectedPathForCurrentTrack,
  };
}
