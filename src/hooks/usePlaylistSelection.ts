import { useState } from 'react';
import type React from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';

export interface PlaylistSelection {
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  lastSelectedIdx: number | null;
  allSelected: boolean;
  toggleAll: () => void;
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
  bulkRemove: () => void;
}

export function usePlaylistSelection(
  songs: SubsonicSong[],
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>,
  savePlaylist: (updatedSongs: SubsonicSong[], prevCount?: number) => Promise<void>,
): PlaylistSelection {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);

  const toggleSelect = (id: string, idx: number, shift: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (shift && lastSelectedIdx !== null) {
        const from = Math.min(lastSelectedIdx, idx);
        const to = Math.max(lastSelectedIdx, idx);
        songs.slice(from, to + 1).forEach(s => next.add(s.id));
      } else {
        next.has(id) ? next.delete(id) : next.add(id);
      }
      return next;
    });
    setLastSelectedIdx(idx);
  };

  const allSelected = selectedIds.size === songs.length && songs.length > 0;
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(songs.map(s => s.id)));

  const bulkRemove = () => {
    const prevCount = songs.length;
    const next = songs.filter(s => !selectedIds.has(s.id));
    setSongs(next);
    savePlaylist(next, prevCount);
    setSelectedIds(new Set());
  };

  return { selectedIds, setSelectedIds, lastSelectedIdx, allSelected, toggleAll, toggleSelect, bulkRemove };
}
