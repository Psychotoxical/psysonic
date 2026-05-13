import { useCallback } from 'react';
import type { SubsonicDirectoryEntry } from '../api/subsonicTypes';
import { usePlayerStore } from '../store/playerStore';
import {
  entryToTrack, folderBrowserHasKeyModifiers, isFolderBrowserArrowKey,
  type Column, type NavPos,
} from '../utils/folderBrowserHelpers';

interface Args {
  columns: Column[];
  filteredItemsByCol: SubsonicDirectoryEntry[][];
  columnFilters: Record<number, string>;
  filterFocusCol: number | null;
  keyboardPos: NavPos | null;
  isContextMenuOpen: boolean;
  filterInputRefs: React.RefObject<Record<number, HTMLInputElement | null>>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  setKeyboardNavActive: React.Dispatch<React.SetStateAction<boolean>>;
  setKeyboardPos: React.Dispatch<React.SetStateAction<NavPos | null>>;
  setContextAnchorPos: React.Dispatch<React.SetStateAction<NavPos | null>>;
  setFilterFocusCol: React.Dispatch<React.SetStateAction<number | null>>;
  preferredRowIndex: (colIndex: number) => number;
  fallbackNavPos: (cols: Column[]) => NavPos | null;
  handleActivate: (colIndex: number, item: SubsonicDirectoryEntry) => void;
  handleDirClick: (colIndex: number, item: SubsonicDirectoryEntry) => void;
  setSelectedInColumn: (colIndex: number, itemId: string) => void;
  clearSelectedInColumn: (colIndex: number) => void;
  openContextMenuForEntry: (col: Column, item: SubsonicDirectoryEntry, x: number, y: number) => void;
  clearFiltersRightOf: (colIndex: number) => void;
}

export function useFolderBrowserKeyboardNav({
  columns, filteredItemsByCol, columnFilters, filterFocusCol, keyboardPos,
  isContextMenuOpen, filterInputRefs, wrapperRef,
  setKeyboardNavActive, setKeyboardPos, setContextAnchorPos, setFilterFocusCol,
  preferredRowIndex, fallbackNavPos,
  handleActivate, handleDirClick, setSelectedInColumn, clearSelectedInColumn,
  openContextMenuForEntry, clearFiltersRightOf,
}: Args) {
  const enqueue = usePlayerStore(s => s.enqueue);

  return useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isContextMenuOpen) return;
    const target = e.target as HTMLElement;
    const inFilterInput =
      target instanceof HTMLInputElement && target.dataset.folderFilterInput === 'true';
    if (inFilterInput) return;
    const key = e.key;
    if (e.ctrlKey && e.code === 'KeyF') {
      e.preventDefault();
      const current = keyboardPos ?? fallbackNavPos(columns);
      if (!current) return;
      const colIndex = current.colIndex;
      setFilterFocusCol(colIndex);
      requestAnimationFrame(() => {
        const input = filterInputRefs.current?.[colIndex];
        if (!input) return;
        input.focus();
        input.select();
      });
      return;
    }
    if (isFolderBrowserArrowKey(e) && folderBrowserHasKeyModifiers(e)) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    setKeyboardNavActive(true);
    const current = keyboardPos ?? fallbackNavPos(columns);
    if (!current) return;

    const col = columns[current.colIndex];
    const visibleItems = filteredItemsByCol[current.colIndex] ?? [];
    const item = visibleItems[current.rowIndex];
    if (!col || !item) return;

    e.preventDefault();

    if (key === 'Enter' && e.ctrlKey) {
      setContextAnchorPos(current);
      const rowEl = wrapperRef.current?.querySelector<HTMLElement>(
        `.folder-col-row[data-col-index="${current.colIndex}"][data-row-index="${current.rowIndex}"]`,
      );
      const rect = rowEl?.getBoundingClientRect();
      const x = rect ? rect.left + 24 : 24;
      const y = rect ? rect.top + rect.height / 2 : 24;
      openContextMenuForEntry(col, item, x, y);
      return;
    }

    if (key === 'ArrowUp') {
      if (current.rowIndex > 0) {
        const nextRowIndex = current.rowIndex - 1;
        const nextItem = visibleItems[nextRowIndex];
        setKeyboardPos({ colIndex: current.colIndex, rowIndex: nextRowIndex });
        if (nextItem.isDir) handleDirClick(current.colIndex, nextItem);
        else setSelectedInColumn(current.colIndex, nextItem.id);
      } else if (
        current.rowIndex === 0 &&
        (filterFocusCol === current.colIndex || !!columnFilters[current.colIndex])
      ) {
        setFilterFocusCol(current.colIndex);
        requestAnimationFrame(() => {
          const input = filterInputRefs.current?.[current.colIndex];
          if (!input) return;
          input.focus();
          input.select();
        });
      }
      return;
    }
    if (key === 'ArrowDown') {
      if (current.rowIndex < visibleItems.length - 1) {
        const nextRowIndex = current.rowIndex + 1;
        const nextItem = visibleItems[nextRowIndex];
        setKeyboardPos({ colIndex: current.colIndex, rowIndex: nextRowIndex });
        if (nextItem.isDir) handleDirClick(current.colIndex, nextItem);
        else setSelectedInColumn(current.colIndex, nextItem.id);
      }
      return;
    }
    if (key === 'ArrowLeft') {
      if (current.colIndex > 0) {
        clearSelectedInColumn(current.colIndex);
        const nextColIndex = current.colIndex - 1;
        clearFiltersRightOf(nextColIndex);
        const rowIndex = preferredRowIndex(nextColIndex);
        if (rowIndex >= 0) setKeyboardPos({ colIndex: nextColIndex, rowIndex });
      }
      return;
    }
    if (key === 'ArrowRight') {
      const nextColIndex = current.colIndex + 1;
      if (nextColIndex < columns.length) {
        const nextVisibleItems = filteredItemsByCol[nextColIndex] ?? [];
        const rowIndex = Math.min(preferredRowIndex(nextColIndex), nextVisibleItems.length - 1);
        if (rowIndex >= 0) {
          const nextItem = nextVisibleItems[rowIndex];
          setSelectedInColumn(nextColIndex, nextItem.id);
          setKeyboardPos({ colIndex: nextColIndex, rowIndex });
          return;
        }
      }
      if (item.isDir) handleActivate(current.colIndex, item);
      return;
    }
    if (key === 'Enter') {
      if (e.shiftKey && !item.isDir) {
        const toAppend = (filteredItemsByCol[current.colIndex] ?? [])
          .filter(it => !it.isDir)
          .map(entryToTrack);
        if (toAppend.length > 0) enqueue(toAppend);
        return;
      }
      handleActivate(current.colIndex, item);
    }
  }, [
    keyboardPos, fallbackNavPos, columns, preferredRowIndex, handleActivate, handleDirClick,
    setSelectedInColumn, clearSelectedInColumn, openContextMenuForEntry, isContextMenuOpen,
    filteredItemsByCol, filterFocusCol, columnFilters, enqueue, clearFiltersRightOf,
    filterInputRefs, wrapperRef, setKeyboardNavActive, setKeyboardPos, setContextAnchorPos,
    setFilterFocusCol,
  ]);
}
