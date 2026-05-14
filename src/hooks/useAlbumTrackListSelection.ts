import React, { useCallback, useEffect, useRef } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useSelectionStore } from '../store/selectionStore';
import { useDragDrop } from '../contexts/DragDropContext';
import { songToTrack } from '../utils/playback/songToTrack';

interface UseAlbumTrackListSelectionArgs {
  songs: SubsonicSong[];
  tracklistRef: React.RefObject<HTMLDivElement | null>;
}

interface UseAlbumTrackListSelectionResult {
  inSelectMode: boolean;
  allSelected: boolean;
  onToggleSelect: (id: string, globalIdx: number, shift: boolean) => void;
  onDragStart: (song: SubsonicSong, me: MouseEvent) => void;
  toggleAll: () => void;
}

/**
 * Bulk selection + drag wiring for `AlbumTrackList`:
 *  - Clears selection whenever the song list changes (album switch or
 *    filter applied) and on mousedown outside the tracklist.
 *  - `onToggleSelect` supports shift-click ranges anchored against the
 *    last toggled row.
 *  - `onDragStart` promotes a single-row drag into a multi-row drag when
 *    the dragged song is part of the active selection.
 *
 * Subscribes only to `selectedIds.size` so the host component re-renders
 * once when select-mode flips on/off; per-row state stays inside
 * `TrackRow`'s own primitive selector for O(1) toggles.
 */
export function useAlbumTrackListSelection({
  songs,
  tracklistRef,
}: UseAlbumTrackListSelectionArgs): UseAlbumTrackListSelectionResult {
  const psyDrag = useDragDrop();
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;
  const allSelected = selectedCount === songs.length && songs.length > 0;
  const lastSelectedIdxRef = useRef<number | null>(null);

  useEffect(() => {
    useSelectionStore.getState().clearAll();
    lastSelectedIdxRef.current = null;
  }, [songs]);

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

  const onToggleSelect = useCallback((id: string, globalIdx: number, shift: boolean) => {
    useSelectionStore.getState().setSelectedIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdxRef.current !== null) {
        const from = Math.min(lastSelectedIdxRef.current, globalIdx);
        const to   = Math.max(lastSelectedIdxRef.current, globalIdx);
        songs.slice(from, to + 1).forEach(s => next.add(s.id));
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      lastSelectedIdxRef.current = globalIdx;
      return next;
    });
  }, [songs]);

  const onDragStart = useCallback((song: SubsonicSong, me: MouseEvent) => {
    const { selectedIds } = useSelectionStore.getState();
    if (selectedIds.has(song.id) && selectedIds.size > 1) {
      const tracks = songs
        .filter(s => selectedIds.has(s.id))
        .map(s => songToTrack(s));
      psyDrag.startDrag(
        { data: JSON.stringify({ type: 'songs', tracks }), label: `${tracks.length} Songs` },
        me.clientX, me.clientY,
      );
    } else {
      psyDrag.startDrag(
        { data: JSON.stringify({ type: 'song', track: songToTrack(song) }), label: song.title },
        me.clientX, me.clientY,
      );
    }
  }, [songs, psyDrag]);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      useSelectionStore.getState().clearAll();
    } else {
      useSelectionStore.getState().setSelectedIds(() => new Set(songs.map(s => s.id)));
    }
  }, [allSelected, songs]);

  return { inSelectMode, allSelected, onToggleSelect, onDragStart, toggleAll };
}
