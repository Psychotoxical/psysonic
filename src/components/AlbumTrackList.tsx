import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import type { Track } from '../store/playerStoreTypes';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioLines, Check, ChevronDown, RotateCcw } from 'lucide-react';
import { useTracklistColumns, type ColDef } from '../utils/useTracklistColumns';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import { useDragDrop } from '../contexts/DragDropContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSelectionStore } from '../store/selectionStore';
import {
  CENTERED_COLS,
  COLUMNS,
  formatDuration,
  isSortable,
  type ColKey,
  type SortKey,
} from '../utils/albumTrackListHelpers';
import { TrackRow } from './albumTrackList/TrackRow';

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

  const handleHeaderClick = (key: ColKey | string) => {
    if (!isSortable(key) || !onSort) return;
    onSort(key);
  };

  const renderSortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return (
      <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
        {sortDir === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  // ── Header cell renderer ──────────────────────────────────────────────────
  const renderHeaderCell = (colDef: ColDef, colIndex: number) => {
    const key = colDef.key as ColKey;
    const isLastCol = colIndex === visibleCols.length - 1;
    const isCentered = CENTERED_COLS.has(key);
    const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey as string}`) : '';
    const canSort = isSortable(key) && onSort;
    const isActive = canSort && sortKey === key;

    if (key === 'num') {
      return (
        <div key={key} className="track-num">
          <span
            className={`bulk-check${allSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
            onClick={e => { e.stopPropagation(); toggleAll(); }}
            style={{ cursor: 'pointer' }}
          />
          <span className="track-num-number">#</span>
        </div>
      );
    }

    if (key === 'title') {
      const hasNextCol = colIndex + 1 < visibleCols.length;
      return (
        <div
          key={key}
          style={{
            position: 'relative',
            padding: 0,
            margin: 0,
            minWidth: 0,
            overflow: 'hidden',
            cursor: canSort ? 'pointer' : 'default',
            userSelect: 'none',
          }}
          onClick={() => handleHeaderClick(key)}
          className={isActive ? 'tracklist-header-cell-active' : ''}
        >
          <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 12 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 600 : 400 }}>{label}</span>
            {canSort && renderSortIndicator(key as SortKey)}
          </div>
          {hasNextCol && (
            <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />
          )}
        </div>
      );
    }

    const isResizable = !isLastCol;
    return (
      <div
        key={key}
        style={{
          position: 'relative',
          padding: 0,
          margin: 0,
          minWidth: 0,
          overflow: 'hidden',
          cursor: canSort ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onClick={() => handleHeaderClick(key)}
        className={isActive ? 'tracklist-header-cell-active' : ''}
      >
        <div
          style={{
            display: 'flex', width: '100%', height: '100%', alignItems: 'center',
            justifyContent: isCentered ? 'center' : 'flex-start',
            paddingLeft: isCentered ? 0 : 12,
          }}
        >
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isActive ? 600 : 400 }}>{label}</span>
          {canSort && isSortable(key) && renderSortIndicator(key as SortKey)}
        </div>
        {isResizable && (
          <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />
        )}
      </div>
    );
  };

  // ── Mobile tracklist ──────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="tracklist-mobile">
        {discNums.map(discNum => (
          <div key={discNum}>
            {isMultiDisc && (
              <div className="disc-header">
                <span className="disc-icon">💿</span> CD {discNum}
              </div>
            )}
            {discs.get(discNum)!.map(song => {
              const isActive = currentTrackId === song.id;
              return (
                <div
                  key={song.id}
                  className={`tracklist-mobile-row${isActive ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                  onClick={() => onPlaySong(song)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setContextMenuSongId(song.id);
                    onContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
                  }}
                >
                  <div className="tracklist-mobile-main">
                    {isActive && isPlaying ? (
                      <span className="tracklist-mobile-eq">
                        <AudioLines className="eq-bars" size={14} />
                      </span>
                    ) : (
                      <span className="tracklist-mobile-num">{song.track ?? ''}</span>
                    )}
                    <span className="tracklist-mobile-title">{song.title}</span>
                  </div>
                  <span className="tracklist-mobile-duration">{formatDuration(song.duration)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {/* Column visibility picker - outside .tracklist to avoid overflow cutoff */}
      <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
        <div className="tracklist-col-picker">
          <button
            className="tracklist-col-picker-btn"
            onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }}
            data-tooltip={t('albumDetail.columns')}
          >
            <ChevronDown size={14} />
          </button>
          {pickerOpen && (
            <div className="tracklist-col-picker-menu">
              <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
              {COLUMNS.filter(c => !c.required).map(c => {
                const label = c.i18nKey ? t(`albumDetail.${c.i18nKey as string}`) : c.key;
                const isOn = colVisible.has(c.key);
                return (
                  <button
                    key={c.key}
                    className={`tracklist-col-picker-item${isOn ? ' active' : ''}`}
                    onClick={() => toggleColumn(c.key)}
                  >
                    <span className="tracklist-col-picker-check">
                      {isOn && <Check size={13} />}
                    </span>
                    {label}
                  </button>
                );
              })}
              <div className="tracklist-col-picker-divider" />
              <button className="tracklist-col-picker-reset" onClick={resetColumns}>
                <RotateCcw size={13} />
                {t('albumDetail.resetColumns')}
              </button>
            </div>
          )}
        </div>
      </div>

    <div
        className="tracklist"
        ref={tracklistRef}
        data-preview-loc="albums"
        onClick={e => {
          if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
        }}
      >

      {/* ── Header ── */}
      <div className="tracklist-header-wrapper">
        <div className="tracklist-header" style={gridStyle}>
          {visibleCols.map((colDef, colIndex) => renderHeaderCell(colDef, colIndex))}
        </div>
      </div>

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
