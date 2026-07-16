import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getMusicDirectoryForServer, getMusicIndexesForServer } from '@/lib/api/subsonicLibrary';
import type { SubsonicDirectoryEntry } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import type { Column, NavPos } from '@/features/folderBrowser/utils/folderBrowserHelpers';

let persistedPlayingPath: { serverId: string; ids: string[] } | null = null;

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
  const [playingPathIds, setPlayingPathIds] = useState<string[]>(() => {
    const persisted = persistedPlayingPath;
    return persisted && persisted.serverId === currentTrack?.serverId ? persisted.ids : [];
  });
  const autoResolvedTrackRef = useRef<string | null>(null);
  const prevTrackIdRef = useRef<string | null>(null);
  const lastHotkeyRevealTsRef = useRef<number | null>(null);
  const location = useLocation();

  useEffect(() => {
    if (!currentTrack?.id) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlayingPathIds([]);
      return;
    }
    setPlayingPathIds(prev => (prev[prev.length - 1] === currentTrack.id ? prev : []));
  }, [currentTrack?.id, currentTrack?.serverId]);

  useEffect(() => {
    if (!isPlaying || !currentTrack?.id) return;
    const selectedChain = columns
      .map(c => c.selectedId)
      .filter((id): id is string => !!id);
    if (selectedChain.length === 0) return;

    const lastSelectedId = selectedChain[selectedChain.length - 1];
    const leafColumn = [...columns].reverse().find(c => c.selectedId);
    const leafItem = leafColumn?.items.find(it => it.id === lastSelectedId);
    if (!leafItem || leafItem.isDir || leafItem.id !== currentTrack.id) return;

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
  }, [columns, currentTrack?.id, isPlaying]);

  useEffect(() => {
    persistedPlayingPath = currentTrack?.serverId
      ? { serverId: currentTrack.serverId, ids: playingPathIds }
      : null;
  }, [playingPathIds, currentTrack?.serverId]);

  const resolveColumnsForTrack = useCallback(async (
    track: Track,
    roots: SubsonicDirectoryEntry[],
  ): Promise<Column[] | null> => {
    for (const root of roots) {
      const serverId = root.serverId ?? track.serverId;
      if (!serverId || (track.serverId && track.serverId !== serverId)) continue;
      let indexes: SubsonicDirectoryEntry[];
      try {
        indexes = await getMusicIndexesForServer(serverId, root.id);
      } catch {
        continue;
      }

      const artistEntry =
        indexes.find(it => it.isDir && !!track.artistId && it.id === track.artistId) ??
        indexes.find(it => it.isDir && it.title === track.artist);
      if (!artistEntry) continue;

      let artistChildren: SubsonicDirectoryEntry[];
      try {
        artistChildren = (await getMusicDirectoryForServer(serverId, artistEntry.id)).child;
      } catch {
        continue;
      }

      const albumEntry = artistChildren.find(it =>
        it.isDir &&
        (
          (!!track.albumId && (it.albumId === track.albumId || it.id === track.albumId)) ||
          (!!track.album && (it.album === track.album || it.title === track.album))
        ),
      );
      if (!albumEntry) continue;

      let albumChildren: SubsonicDirectoryEntry[];
      try {
        albumChildren = (await getMusicDirectoryForServer(serverId, albumEntry.id)).child;
      } catch {
        continue;
      }
      const songEntry = albumChildren.find(it => !it.isDir && it.id === track.id);
      if (!songEntry) continue;

      return [
        { id: 'root', serverId: '', name: '', items: roots, selectedId: root.id, loading: false, error: false, kind: 'roots' },
        { id: root.id, serverId, name: root.title, items: indexes, selectedId: artistEntry.id, loading: false, error: false, kind: 'indexes' },
        { id: artistEntry.id, serverId, name: artistEntry.title, items: artistChildren, selectedId: albumEntry.id, loading: false, error: false, kind: 'directory' },
        { id: albumEntry.id, serverId, name: albumEntry.title, items: albumChildren, selectedId: songEntry.id, loading: false, error: false, kind: 'directory' },
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
    if (autoResolvedTrackRef.current === currentTrack.id && !forceReveal) return;

    const rootCol = columns[0];
    if (!rootCol || rootCol.loading || rootCol.error || rootCol.items.length === 0) return;

    const selectedLeafId =
      [...columns].reverse().find(c => c.selectedId)?.selectedId ?? null;
    const wasOnPreviousTrackPath = !!prevTrackIdRef.current && selectedLeafId === prevTrackIdRef.current;
    if (selectedLeafId === currentTrack.id) {
      autoResolvedTrackRef.current = currentTrack.id;
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
      const path = resolved.map(c => c.selectedId).filter((id): id is string => !!id);
      setPlayingPathIds(path);
      const leafColIndex = resolved.length - 1;
      const leafRowIndex = resolved[leafColIndex].items.findIndex(it => it.id === currentTrack.id);
      if (leafRowIndex >= 0) setKeyboardPos({ colIndex: leafColIndex, rowIndex: leafRowIndex });
      autoResolvedTrackRef.current = currentTrack.id;
      if (hotkeyRevealRequested) {
        lastHotkeyRevealTsRef.current = hotkeyRevealTs;
      }
    });

    return () => { cancelled = true; };
  }, [columns, currentTrack, resolveColumnsForTrack, location.state, setColumns, setKeyboardPos]);

  useEffect(() => {
    prevTrackIdRef.current = currentTrack?.id ?? null;
  }, [currentTrack?.id]);

  const isSelectedPathForCurrentTrack =
    isPlaying && !!currentTrack && playingPathIds[playingPathIds.length - 1] === currentTrack.id;

  return {
    playingPathIds,
    setPlayingPathIds,
    isSelectedPathForCurrentTrack,
  };
}
