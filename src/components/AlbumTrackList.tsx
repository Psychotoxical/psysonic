import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import type { Track } from '../store/playerStoreTypes';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTracklistColumns } from '../utils/useTracklistColumns';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import { useDragDrop } from '../contexts/DragDropContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSelectionStore } from '../store/selectionStore';
import {
  COLUMNS,
  type SortKey,
} from '../utils/albumTrackListHelpers';
import { TrackRow } from './albumTrackList/TrackRow';
import { AlbumTrackListMobile } from './albumTrackList/AlbumTrackListMobile';
import { TracklistColumnPicker } from './albumTrackList/TracklistColumnPicker';
import { TracklistHeaderRow } from './albumTrackList/TracklistHeaderRow';

export type { SortKey } from '../utils/albumTrackListHelpers';

interface AlbumTrackListProps {
  songs: SubsonicSong[];
  sorted?: boolean;
  hasVariousArtists: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  ratings: Record<string, number>;
  userRatingOverrides: Record<string, number>;
  starredSongs: Set<string>;
  onPlaySong: (song: SubsonicSong) => void;
  /** Optional dbl-click handler — currently set only in Orbit mode so the list knows to bind it. */
  onDoubleClickSong?: (song: SubsonicSong) => void;
  onRate: (songId: string, rating: number) => void;
  onToggleSongStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  onContextMenu: (x: number, y: number, track: Track, type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song') => void;
  sortKey?: SortKey;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: SortKey) => void;
}

// ── AlbumTrackList ────────────────────────────────────────────────────────────

export default function AlbumTrackList({
  songs,
  sorted,
  hasVariousArtists: _hasVariousArtists,
  currentTrack,
  isPlaying,
  ratings,
  userRatingOverrides,
  starredSongs,
  onPlaySong,
  onDoubleClickSong,
  onRate,
  onToggleSongStar,
  onContextMenu,
  sortKey,
  sortDir,
  onSort,
}: AlbumTrackListProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [contextMenuSongId, setContextMenuSongId] = useState<string | null>(null);
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);
  const psyDrag = useDragDrop();

  // Selection state lives in selectionStore — only the toggled row re-renders (O(1)).
  const selectedCount = useSelectionStore(s => s.selectedIds.size);
  const inSelectMode = selectedCount > 0;
  const allSelected = selectedCount === songs.length && songs.length > 0;
  const lastSelectedIdxRef = useRef<number | null>(null);

  // ── Column state ──────────────────────────────────────────────────────────
  const {
    colVisible, visibleCols, gridStyle,
    startResize, toggleColumn, resetColumns,
    pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  } = useTracklistColumns(COLUMNS, 'psysonic_tracklist_columns');

  // Clear selection when the song list changes (different album / filter applied).
  useEffect(() => {
    useSelectionStore.getState().clearAll();
    lastSelectedIdxRef.current = null;
  }, [songs]);

  useEffect(() => {
    if (!contextMenuOpen) setContextMenuSongId(null);
  }, [contextMenuOpen]);

  // Clear selection on click outside the tracklist (header, album art, etc.)
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

  // ── Stable callbacks passed to memoised TrackRow ──────────────────────────

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

  // Drag: if the dragged song is part of the selection, drag all selected songs.
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

  // ── Disc grouping ─────────────────────────────────────────────────────────
  const discs = new Map<number, SubsonicSong[]>();
  if (!sorted) {
    songs.forEach(song => {
      const disc = song.discNumber ?? 1;
      if (!discs.has(disc)) discs.set(disc, []);
      discs.get(disc)!.push(song);
    });
  } else {
    discs.set(1, songs as SubsonicSong[]);
  }
  const discNums = sorted ? [1] : Array.from(discs.keys()).sort((a, b) => a - b);
  const isMultiDisc = !sorted && discNums.length > 1;

  const currentTrackId = currentTrack?.id ?? null;

  if (isMobile) {
    return (
      <AlbumTrackListMobile
        discNums={discNums}
        discs={discs}
        isMultiDisc={isMultiDisc}
        currentTrackId={currentTrackId}
        isPlaying={isPlaying}
        contextMenuSongId={contextMenuSongId}
        setContextMenuSongId={setContextMenuSongId}
        onPlaySong={onPlaySong}
        onContextMenu={onContextMenu}
      />
    );
  }

  return (
    <>
      <TracklistColumnPicker
        pickerRef={pickerRef}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        colVisible={colVisible}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        t={t}
      />

    <div
        className="tracklist"
        ref={tracklistRef}
        data-preview-loc="albums"
        onClick={e => {
          if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
        }}
      >

      <TracklistHeaderRow
        visibleCols={visibleCols}
        gridStyle={gridStyle}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        allSelected={allSelected}
        inSelectMode={inSelectMode}
        toggleAll={toggleAll}
        startResize={startResize}
        t={t}
      />

      {/* ── Tracks ── */}
      {discNums.map(discNum => (
        <div key={discNum}>
          {isMultiDisc && (
            <div className="disc-header">
              <span className="disc-icon">💿</span>
              CD {discNum}
            </div>
          )}
          {discs.get(discNum)!.map(song => {
            const globalIdx = songs.indexOf(song);
            return (
              <TrackRow
                key={song.id}
                song={song}
                globalIdx={globalIdx}
                visibleCols={visibleCols}
                gridStyle={gridStyle}
                currentTrackId={currentTrackId}
                isPlaying={isPlaying}
                ratingValue={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0}
                isStarred={starredSongs.has(song.id)}
                inSelectMode={inSelectMode}
                isContextMenuSong={contextMenuSongId === song.id}
                onPlaySong={onPlaySong}
                onDoubleClickSong={onDoubleClickSong}
                onRate={onRate}
                onToggleSongStar={onToggleSongStar}
                onContextMenu={onContextMenu}
                onToggleSelect={onToggleSelect}
                onDragStart={onDragStart}
                setContextMenuSongId={setContextMenuSongId}
              />
            );
          })}
        </div>
      ))}

    </div>
    </>
  );
}
