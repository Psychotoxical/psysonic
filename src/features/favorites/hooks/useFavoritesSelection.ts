import React, { useCallback, useEffect, useRef } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useSelectionStore } from '@/store/selectionStore';

export interface FavoritesSelectionResult {
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
}

export function useFavoritesSelection(
  visibleSongs: SubsonicSong[],
  inSelectMode: boolean,
  tracklistRef: React.RefObject<HTMLDivElement | null>,
): FavoritesSelectionResult {
  const lastSelectedIdxRef = useRef<number | null>(null);

  // Clear selection when song list changes
  useEffect(() => {
    useSelectionStore.getState().clearAll();
    lastSelectedIdxRef.current = null;
  }, [visibleSongs]);

  // Clear selection on click outside tracklist
  useEffect(() => {
    if (!inSelectMode) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!tracklistRef.current || tracklistRef.current.contains(target)) return;
      // Toolbar (play/enqueue, filters, bulk actions) sits outside the tracklist
      // DOM but belongs to the selection — don't clear before its click runs.
      if (target.closest('.favorites-songs-toolbar, .bulk-pl-picker-wrap, .context-submenu')) return;
      useSelectionStore.getState().clearAll();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [inSelectMode, tracklistRef]);

  const toggleSelect = useCallback((id: string, idx: number, shift: boolean) => {
    useSelectionStore.getState().setSelectedIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdxRef.current !== null) {
        const from = Math.min(lastSelectedIdxRef.current, idx);
        const to = Math.max(lastSelectedIdxRef.current, idx);
        for (let j = from; j <= to; j++) {
          const sid = visibleSongs[j]?.id;
          if (sid) next.add(sid);
        }
      } else {
        if (next.has(id)) { next.delete(id); }
        else { next.add(id); lastSelectedIdxRef.current = idx; }
      }
      return next;
    });
  }, [visibleSongs]);

  return { toggleSelect };
}
