import type { SubsonicDirectoryEntry, SubsonicArtist } from '@/lib/api/subsonicTypes';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useTranslation } from 'react-i18next';
import {
  albumDtoToFolderEntry, artistDtoToFolderEntry, entryToAlbumIfPresent, entryToTrack,
  folderBrowserEntryKey,
  trackDtoToFolderEntry,
  type Column, type ColumnKind, type NavPos,
} from '@/features/folderBrowser/utils/folderBrowserHelpers';
import FolderBrowserColumn from '@/features/folderBrowser/components/FolderBrowserColumn';
import { useFolderBrowserNowPlayingPath } from '@/features/folderBrowser/hooks/useFolderBrowserNowPlayingPath';
import { useFolderBrowserScrolling } from '@/features/folderBrowser/hooks/useFolderBrowserScrolling';
import { useFolderBrowserKeyboardNav } from '@/features/folderBrowser/hooks/useFolderBrowserKeyboardNav';
import { useAuthStore } from '@/store/authStore';
import {
  libraryScopeAlbumDetail,
  libraryScopeArtistDetail,
  libraryScopeListArtists,
} from '@/lib/api/library/scopeReads';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';

export default function FolderBrowser() {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<Column[]>([]);
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [filterFocusCol, setFilterFocusCol] = useState<number | null>(null);
  const [keyboardNavActive, setKeyboardNavActive] = useState(false);
  const filterInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const pendingNavColRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(0);
  const [keyboardPos, setKeyboardPos] = useState<NavPos | null>(null);
  const [contextAnchorPos, setContextAnchorPos] = useState<NavPos | null>(null);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const isContextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const unavailableServerIds = useUnavailableServerIds();
  const musicFoldersByServer = useAuthStore(s => s.musicFoldersByServer);
  const libraryBrowseSelectionByServer = useAuthStore(s => s.libraryBrowseSelectionByServer);
  const visibleServers = useMemo(() => {
    const serverIds = new Set(deriveEffectiveLibraryBrowseServerIds({
      servers,
      activeServerId,
      libraryBrowseServerIds,
    }, unavailableServerIds));
    return servers.filter(server => serverIds.has(server.id));
  }, [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);

  const { wrapperRef, columnsViewportWidth } = useFolderBrowserScrolling({
    columns, keyboardPos, keyboardNavActive, setKeyboardNavActive,
  });

  const { playingPathIds, setPlayingPathIds, isSelectedPathForCurrentTrack } =
    useFolderBrowserNowPlayingPath({ columns, currentTrack, isPlaying, setColumns, setKeyboardPos });

  useEffect(() => {
    const placeholder: Column = {
      id: 'root',
      name: '',
      items: [],
      selectedKey: null,
      loading: true,
      error: false,
      kind: 'roots',
    };
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColumns([placeholder]);
    const items: SubsonicDirectoryEntry[] = visibleServers.flatMap(server => {
      const folders = musicFoldersByServer[server.id] ?? [];
      const selectedIds = libraryBrowseSelectionByServer[server.id] ?? [];
      return folders
        .filter(folder => selectedIds.length === 0 || selectedIds.includes(folder.id))
        .map(folder => ({
          id: folder.id,
          sourceId: folder.id,
          serverId: server.id,
          title: `${server.name} - ${folder.name}`,
          isDir: true,
        }));
    });
    setColumns([{ ...placeholder, items, loading: false }]);
  }, [libraryBrowseSelectionByServer, musicFoldersByServer, visibleServers]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setColumnFilters(prev => {
      const next: Record<number, string> = {};
      let changed = false;
      Object.entries(prev).forEach(([k, v]) => {
        const idx = Number(k);
        if (idx < columns.length) next[idx] = v;
        else changed = true;
      });
      return changed ? next : prev;
    });
    setFilterFocusCol(prev => (prev !== null && prev >= columns.length ? null : prev));
  }, [columns.length]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isContextMenuOpen) setContextAnchorPos(null);
  }, [isContextMenuOpen]);

  const filteredItemsByCol = useMemo(() => {
    return columns.map((col, colIndex) => {
      const query = (columnFilters[colIndex] ?? '').trim().toLowerCase();
      if (!query) return col.items;
      return col.items.filter(item => {
        const haystack = `${item.title} ${item.artist ?? ''} ${item.album ?? ''}`.toLowerCase();
        return haystack.includes(query);
      });
    });
  }, [columns, columnFilters]);

  const preferredRowIndex = useCallback((colIndex: number): number => {
    const items = filteredItemsByCol[colIndex] ?? [];
    if (items.length === 0) return -1;
    const selectedKey = columns[colIndex]?.selectedKey;
    if (selectedKey) {
      const selectedIdx = items.findIndex(it => folderBrowserEntryKey(it) === selectedKey);
      if (selectedIdx >= 0) return selectedIdx;
    }
    return 0;
  }, [filteredItemsByCol, columns]);

  const fallbackNavPos = useCallback((cols: Column[]): NavPos | null => {
    for (let c = 0; c < cols.length; c++) {
      const rowIndex = preferredRowIndex(c);
      if (rowIndex >= 0) return { colIndex: c, rowIndex };
    }
    return null;
  }, [preferredRowIndex]);

  useEffect(() => {
    if (pendingNavColRef.current !== null) {
      const targetColIndex = pendingNavColRef.current;
      const targetCol = columns[targetColIndex];
      const targetItems = filteredItemsByCol[targetColIndex] ?? [];
      if (targetCol && targetItems.length > 0 && !targetCol.loading && !targetCol.error) {
        const rowIndex = preferredRowIndex(targetColIndex);
        const safeRowIndex = Math.min(Math.max(0, rowIndex), targetItems.length - 1);
        const targetItem = targetItems[safeRowIndex];
        setColumns(prev =>
          prev.map((c, i) => (i === targetColIndex ? { ...c, selectedKey: folderBrowserEntryKey(targetItem) } : c)),
        );
        setKeyboardPos({
          colIndex: targetColIndex,
          rowIndex: safeRowIndex,
        });
        pendingNavColRef.current = null;
        return;
      }
    }

    setKeyboardPos(prev => {
      if (!prev) return fallbackNavPos(columns);
      if (prev.colIndex >= columns.length) return fallbackNavPos(columns);
      const col = columns[prev.colIndex];
      const visibleItems = filteredItemsByCol[prev.colIndex] ?? [];
      if (col.loading || col.error || visibleItems.length === 0) return fallbackNavPos(columns);
      if (prev.rowIndex >= visibleItems.length) {
        return { colIndex: prev.colIndex, rowIndex: visibleItems.length - 1 };
      }
      return prev;
    });
  }, [columns, fallbackNavPos, preferredRowIndex, filteredItemsByCol]);

  const clearFiltersRightOf = useCallback((colIndex: number) => {
    setColumnFilters(prev => {
      const next: Record<number, string> = {};
      let changed = false;
      Object.entries(prev).forEach(([k, v]) => {
        const idx = Number(k);
        if (idx <= colIndex) next[idx] = v;
        else changed = true;
      });
      return changed ? next : prev;
    });
    setFilterFocusCol(prev => (prev !== null && prev > colIndex ? null : prev));
  }, []);

  const handleDirClick = useCallback((colIndex: number, item: SubsonicDirectoryEntry) => {
    const serverId = item.serverId ?? columns[colIndex]?.serverId;
    if (!serverId) return;
    clearFiltersRightOf(colIndex);
    const scopes = colIndex === 0
      ? [{ serverId, libraryId: item.sourceId ?? item.id }]
      : columns[colIndex]?.scopes ?? [];
    const nextKind: ColumnKind = colIndex === 0
      ? 'artists'
      : columns[colIndex]?.kind === 'artists'
        ? 'albums'
        : 'tracks';
    const requestGeneration = ++requestGenerationRef.current;
    const parentKey = folderBrowserEntryKey(item);
    const targetColIndex = colIndex + 1;
    setColumns(prev => [
      ...prev.slice(0, colIndex + 1).map((c, i) =>
        i === colIndex ? { ...c, selectedKey: parentKey } : c,
      ),
      {
        id: item.id,
        name: item.title,
        items: [],
        selectedKey: null,
        loading: true,
        error: false,
        kind: nextKind,
        serverId,
        scopes,
      },
    ]);

    const fetchItems = colIndex === 0
      ? libraryScopeListArtists(serverId, { scopes, sort: 'name', limit: 10_000 })
        .then(artists => artists.map(artistDtoToFolderEntry))
      : columns[colIndex]?.kind === 'artists'
        ? libraryScopeArtistDetail(serverId, { scopes, artistId: item.id, serverId, includeTracks: false })
          // An artist folder lists everything under that artist, including albums they
          // only appear on — the discography split is an artist-page concern.
          .then(response => [...response.albums, ...response.appearsOnAlbums]
            .map(albumDtoToFolderEntry))
        : libraryScopeAlbumDetail(serverId, { scopes, albumId: item.id, serverId })
          .then(response => response.tracks.map(trackDtoToFolderEntry));

    fetchItems
      .then(items => {
        const serverItems = items.map(entry => ({ ...entry, serverId: entry.serverId ?? serverId }));
        setColumns(prev => {
          const parent = prev[colIndex];
          const target = prev[targetColIndex];
          if (
            requestGenerationRef.current !== requestGeneration
            || parent?.selectedKey !== parentKey
            || !target?.loading
            || target.id !== item.id
            || target.serverId !== serverId
          ) return prev;
          const next = [...prev];
          next[targetColIndex] = { ...target, items: serverItems, loading: false };
          return next;
        });
      })
      .catch(() => {
        setColumns(prev => {
          const parent = prev[colIndex];
          const target = prev[targetColIndex];
          if (
            requestGenerationRef.current !== requestGeneration
            || parent?.selectedKey !== parentKey
            || !target?.loading
            || target.id !== item.id
            || target.serverId !== serverId
          ) return prev;
          const next = [...prev];
          next[targetColIndex] = { ...target, loading: false, error: true };
          return next;
        });
      });
  }, [clearFiltersRightOf, columns]);

  const handleFileClick = useCallback(
    (colIndex: number, item: SubsonicDirectoryEntry) => {
      setColumns(prev =>
        prev.map((c, i) => (i === colIndex ? { ...c, selectedKey: folderBrowserEntryKey(item) } : c)),
      );
      const path = [
        ...columns.slice(0, colIndex).map(c => c.selectedKey).filter((key): key is string => !!key),
        folderBrowserEntryKey(item),
      ];
      setPlayingPathIds(path);
      const visibleItems = filteredItemsByCol[colIndex] ?? columns[colIndex]?.items ?? [];
      const queue = visibleItems.filter(it => !it.isDir).map(entryToTrack);
      playTrack(entryToTrack(item), queue.length > 0 ? queue : [entryToTrack(item)]);
    },
    [columns, filteredItemsByCol, playTrack, setPlayingPathIds],
  );

  const setSelectedInColumn = useCallback((colIndex: number, item: SubsonicDirectoryEntry) => {
    const itemKey = folderBrowserEntryKey(item);
    setColumns(prev => {
      const prevSelectedKey = prev[colIndex]?.selectedKey ?? null;
      if (prevSelectedKey !== itemKey) {
        clearFiltersRightOf(colIndex);
      }
      return prev.map((c, i) => (i === colIndex ? { ...c, selectedKey: itemKey } : c));
    });
  }, [clearFiltersRightOf]);

  const clearSelectedInColumn = useCallback((colIndex: number) => {
    setColumns(prev =>
      prev.map((c, i) => (i === colIndex ? { ...c, selectedKey: null } : c)),
    );
  }, []);


  const handleActivate = useCallback((colIndex: number, item: SubsonicDirectoryEntry) => {
    if (item.isDir) {
      handleDirClick(colIndex, item);
      pendingNavColRef.current = colIndex + 1;
      return;
    }
    handleFileClick(colIndex, item);
  }, [handleDirClick, handleFileClick]);

  const openContextMenuForEntry = useCallback(
    (col: Column, item: SubsonicDirectoryEntry, x: number, y: number) => {
      if (item.isDir) {
        if (col.kind === 'artists') {
          const artist: SubsonicArtist = {
            id: item.id,
            name: item.title,
            coverArt: item.coverArt,
            serverId: item.serverId,
          };
          openContextMenu(x, y, artist, 'artist');
          return;
        }
        const album = entryToAlbumIfPresent(item);
        if (album) {
          openContextMenu(x, y, album, 'album');
          return;
        }
        if (item.artistId) {
          const artist: SubsonicArtist = {
            id: item.artistId,
            name: item.artist ?? item.title,
            coverArt: item.coverArt,
            serverId: item.serverId,
          };
          openContextMenu(x, y, artist, 'artist');
          return;
        }
        return;
      }
      openContextMenu(x, y, entryToTrack(item), 'song');
    },
    [openContextMenu],
  );

  const onColumnsKeyDown = useFolderBrowserKeyboardNav({
    columns, filteredItemsByCol, columnFilters, filterFocusCol, keyboardPos,
    isContextMenuOpen, filterInputRefs, wrapperRef,
    setKeyboardNavActive, setKeyboardPos, setContextAnchorPos, setFilterFocusCol,
    preferredRowIndex, fallbackNavPos,
    handleActivate, handleDirClick, setSelectedInColumn, clearSelectedInColumn,
    openContextMenuForEntry, clearFiltersRightOf,
  });

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, colIndex: number, rowIndex: number, col: Column, item: SubsonicDirectoryEntry) => {
      e.preventDefault();
      e.stopPropagation();
      setContextAnchorPos({ colIndex, rowIndex });
      openContextMenuForEntry(col, item, e.clientX, e.clientY);
    },
    [openContextMenuForEntry],
  );

  const activeColIndex = useMemo(() => {
    if (keyboardPos) return keyboardPos.colIndex;
    const fromSelection = [...columns]
      .map((c, i) => (c.selectedKey ? i : -1))
      .filter(i => i >= 0);
    if (fromSelection.length > 0) return fromSelection[fromSelection.length - 1];
    return Math.max(0, columns.length - 1);
  }, [columns, keyboardPos]);

  const visibleAnchorColIndex = useMemo(
    () => Math.min(Math.max(0, columns.length - 1), activeColIndex + 1),
    [activeColIndex, columns.length],
  );

  const compactColumnsEnabled = useMemo(() => {
    if (columns.length < 4 || columnsViewportWidth <= 0) return false;
    const expandedColumnWidth = 220;
    return columns.length * expandedColumnWidth > columnsViewportWidth;
  }, [columns.length, columnsViewportWidth]);

  const isColumnCompact = useCallback((col: Column, colIndex: number) => {
    if (!compactColumnsEnabled) return false;
    if (col.loading || col.error || col.items.length === 0) return false;
    return Math.abs(colIndex - visibleAnchorColIndex) > 1;
  }, [compactColumnsEnabled, visibleAnchorColIndex]);

  return (
    <div className="folder-browser">
      <h1 className="page-title folder-browser-title">{t('sidebar.folderBrowser')}</h1>
      <div
        className={`folder-browser-columns${keyboardNavActive ? ' keyboard-nav-active' : ''}${compactColumnsEnabled ? ' folder-browser-columns--compact' : ''}`}
        ref={wrapperRef}
        tabIndex={0}
        onKeyDown={onColumnsKeyDown}
      >
        {columns.map((col, colIndex) => (
          <FolderBrowserColumn
            key={`${col.id}-${colIndex}`}
            col={col}
            colIndex={colIndex}
            isCompact={isColumnCompact(col, colIndex)}
            filterValue={columnFilters[colIndex] ?? ''}
            filterVisible={filterFocusCol === colIndex || !!columnFilters[colIndex]}
            filteredItems={filteredItemsByCol[colIndex] ?? []}
            keyboardRowIndex={keyboardPos?.colIndex === colIndex ? keyboardPos.rowIndex : null}
            contextRowIndex={contextAnchorPos?.colIndex === colIndex ? contextAnchorPos.rowIndex : null}
            currentTrack={currentTrack}
            isPlaying={isPlaying}
            isSelectedPathForCurrentTrack={!!isSelectedPathForCurrentTrack}
            playingPathIds={playingPathIds}
            registerFilterInput={el => { filterInputRefs.current[colIndex] = el; }}
            onFilterFocus={() => setFilterFocusCol(colIndex)}
            onFilterBlur={() => {
              if (!(columnFilters[colIndex] ?? '').trim()) {
                setFilterFocusCol(prev => (prev === colIndex ? null : prev));
              }
            }}
            onFilterEscape={() => {
              setColumnFilters(prev => ({ ...prev, [colIndex]: '' }));
              setFilterFocusCol(null);
              requestAnimationFrame(() => wrapperRef.current?.focus({ preventScroll: true }));
            }}
            onFilterArrowDown={() => {
              const rowIndex = preferredRowIndex(colIndex);
              if (rowIndex >= 0) {
                const nextItem = (filteredItemsByCol[colIndex] ?? [])[rowIndex];
                if (nextItem) {
                  if (nextItem.isDir) handleDirClick(colIndex, nextItem);
                  else setSelectedInColumn(colIndex, nextItem);
                }
                setKeyboardPos({ colIndex, rowIndex });
                requestAnimationFrame(() => wrapperRef.current?.focus({ preventScroll: true }));
              }
            }}
            onFilterChange={value => {
              setColumnFilters(prev => ({ ...prev, [colIndex]: value }));
              setKeyboardPos(prev => {
                if (!prev || prev.colIndex !== colIndex) return prev;
                return { colIndex, rowIndex: 0 };
              });
            }}
            onRowClick={(item, rowIndex) => {
              setKeyboardPos({ colIndex, rowIndex });
              if (item.isDir) handleDirClick(colIndex, item);
              else handleFileClick(colIndex, item);
            }}
            onRowContextMenu={(e, rowIndex, c, item) => {
              setKeyboardPos({ colIndex, rowIndex });
              onRowContextMenu(e, colIndex, rowIndex, c, item);
            }}
          />
        ))}
      </div>
    </div>
  );
}
