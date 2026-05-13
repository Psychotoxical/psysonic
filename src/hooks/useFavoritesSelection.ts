import React, { useCallback, useEffect, useRef } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useSelectionStore } from '../store/selectionStore';

export interface FavoritesSelectionResult {
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
}

export function useFavoritesSelection(
  songs: SubsonicSong[],
  inSelectMode: boolean,
  tracklistRef: React.RefObject<HTMLDivElement | null>,
): FavoritesSelectionResult {
  const lastSelectedIdxRef = useRef<number | null>(null);

  // Clear selection when song list changes
  useEffect(() => {
    useSelectionStore.getState().clearAll();
    lastSelectedIdxRef.current = null;
  }, [songs]);

  // Clear selection on click outside tracklist
  useEffect(() => {
    if (!inSelectMode) return;
    const handler = (e: MouseEvent) => {
      if (tracklistRef.current && !tracklistRef.current.contains(e.target as Node)) {
        useSelectionStore.getState().clearAll();
      }
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
        // we need visibleSongs here — read from latest closure via ref trick
        // Instead, just toggle range based on idx into songs array
        for (let j = from; j <= to; j++) {
          const sid = songs[j]?.id;
          if (sid) next.add(sid);
        }
      } else {
        if (next.has(id)) { next.delete(id); }
        else { next.add(id); lastSelectedIdxRef.current = idx; }
      }
      return next;
    });
  }, [songs]);

  return { toggleSelect };
}
