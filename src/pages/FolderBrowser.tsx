import { getMusicFolders, getMusicDirectory, getMusicIndexes } from '../api/subsonicLibrary';
import type { SubsonicDirectoryEntry, SubsonicArtist } from '../api/subsonicTypes';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import {
  entryToAlbumIfPresent, entryToTrack,
  type Column, type ColumnKind, type NavPos,
} from '../utils/componentHelpers/folderBrowserHelpers';
import FolderBrowserColumn from '../components/folderBrowser/FolderBrowserColumn';
import { useFolderBrowserNowPlayingPath } from '../hooks/useFolderBrowserNowPlayingPath';
import { useFolderBrowserScrolling } from '../hooks/useFolderBrowserScrolling';
import { useFolderBrowserKeyboardNav } from '../hooks/useFolderBrowserKeyboardNav';

export default function FolderBrowser() {
  const { t } = useTranslation();
  const [columns, setColumns] = useState<Column[]>([]);
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [filterFocusCol, setFilterFocusCol] = useState<number | null>(null);
  const [keyboardNavActive, setKeyboardNavActive] = useState(false);
  const filterInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const pendingNavColRef = useRef<number | null>(null);
  const [keyboardPos, setKeyboardPos] = useState<NavPos | null>(null);
  const [contextAnchorPos, setContextAnchorPos] = useState<NavPos | null>(null);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const isContextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);

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
      selectedId: null,
      loading: true,
      error: false,
      kind: 'roots',
    };
    setColumns([placeholder]);
    getMusicFolders()
      .then(folders => {
        const items: SubsonicDirectoryEntry[] = folders.map(f => ({
          id: f.id,
          title: f.name,
          isDir: true,
        }));
        setColumns([{ ...placeholder, items, loading: false }]);
      })
      .catch(() => {
        setColumns([{ ...placeholder, items: [], loading: false, error: true }]);
      });
  }, []);

  useEffect(() => {
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
    const selectedId = columns[colIndex]?.selectedId;
    if (selectedId) {
      const selectedIdx = items.findIndex(it => it.id === selectedId);
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
          prev.map((c, i) => (i === targetColIndex ? { ...c, selectedId: targetItem.id } : c)),
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
    clearFiltersRightOf(colIndex);
    const nextKind: ColumnKind = colIndex === 0 ? 'indexes' : 'directory';
    setColumns(prev => [
      ...prev.slice(0, colIndex + 1).map((c, i) =>
        i === colIndex ? { ...c, selectedId: item.id } : c,
      ),
      {
        id: item.id,
        name: item.title,
        items: [],
        selectedId: null,
        loading: true,
        error: false,
        kind: nextKind,
      },
    ]);

    const fetchItems =
      colIndex === 0 ? getMusicIndexes(item.id) : getMusicDirectory(item.id).then(d => d.child);

    fetchItems
      .then(items => {
        setColumns(prev => {
          const idx = prev.findIndex(c => c.id === item.id && c.loading);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], items, loading: false };
          return next;
        });
      })
      .catch(() => {
        setColumns(prev => {
          const idx = prev.findIndex(c => c.id === item.id && c.loading);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], loading: false, error: true };
          return next;
        });
      });
  }, [clearFiltersRightOf]);

  const handleFileClick = useCallback(
    (colIndex: number, item: SubsonicDirectoryEntry) => {
      setColumns(prev =>
        prev.map((c, i) => (i === colIndex ? { ...c, selectedId: item.id } : c)),
      );
      const path = [
        ...columns.slice(0, colIndex).map(c => c.selectedId).filter((id): id is string => !!id),
        item.id,
      ];
      setPlayingPathIds(path);
      const visibleItems = filteredItemsByCol[colIndex] ?? columns[colIndex]?.items ?? [];
      const queue = visibleItems.filter(it => !it.isDir).map(entryToTrack);
      playTrack(entryToTrack(item), queue.length > 0 ? queue : [entryToTrack(item)]);
    },
    [columns, filteredItemsByCol, playTrack],
  );

  const setSelectedInColumn = useCallback((colIndex: number, itemId: string) => {
    setColumns(prev => {
      const prevSelectedId = prev[colIndex]?.selectedId ?? null;
      if (prevSelectedId !== itemId) {
        clearFiltersRightOf(colIndex);
      }
      return prev.map((c, i) => (i === colIndex ? { ...c, selectedId: itemId } : c));
    });
  }, [clearFiltersRightOf]);

  const clearSelectedInColumn = useCallback((colIndex: number) => {
    setColumns(prev =>
      prev.map((c, i) => (i === colIndex ? { ...c, selectedId: null } : c)),
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
        if (col.kind === 'indexes') {
          const artist: SubsonicArtist = { id: item.id, name: item.title, coverArt: item.coverArt };
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
      .map((c, i) => (c.selectedId ? i : -1))
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
                  else setSelectedInColumn(colIndex, nextItem.id);
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
