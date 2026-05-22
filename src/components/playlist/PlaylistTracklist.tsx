import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import PlaylistRow, { type PlaylistRowCallbacks } from './PlaylistRow';
import { TracklistColumnPicker } from '../albumTrackList/TracklistColumnPicker';
import { useTranslation } from 'react-i18next';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../../constants/appScroll';
import { useElementClientHeightById } from '../../hooks/useResizeClientHeight';
import { useNavigate } from 'react-router-dom';
import {
  ListPlus, Search, Trash2, X,
} from 'lucide-react';
import type { ColDef } from '../../utils/useTracklistColumns';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { usePlayerStore } from '../../store/playerStore';
import { usePreviewStore } from '../../store/previewStore';
import { useThemeStore } from '../../store/themeStore';
import { useDragDrop } from '../../contexts/DragDropContext';
import { useOrbitSongRowBehavior } from '../../hooks/useOrbitSongRowBehavior';
import { songToTrack } from '../../utils/playback/songToTrack';
import type { PlaylistSortKey, PlaylistSortDir } from '../../utils/playlist/playlistDisplayedSongs';
import { AddToPlaylistSubmenu } from '../ContextMenu';

const PL_CENTERED = new Set(['favorite', 'rating', 'duration', 'playCount', 'bpm']);

interface Props {
  // Column config / picker
  allColumns: readonly ColDef[];
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  colVisible: Set<string>;
  toggleColumn: (key: string) => void;
  resetColumns: () => void;
  pickerOpen: boolean;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  startResize: (e: React.MouseEvent, colIndex: number, direction?: 1 | -1) => void;
  tracklistRef: React.RefObject<HTMLDivElement | null>;

  // Data
  songs: SubsonicSong[];
  displayedSongs: SubsonicSong[];
  displayedTracks: Track[];
  isFiltered: boolean;
  /** True only while a filter text is active — distinct from `isFiltered`,
   *  which also goes true while sorting (displayedSongs !== songs). Drives the
   *  scroll-to-list effect so sorting doesn't snap the viewport (issue #840). */
  hasActiveFilter: boolean;
  id: string | undefined;

  // Sort
  sortKey: PlaylistSortKey;
  setSortKey: React.Dispatch<React.SetStateAction<PlaylistSortKey>>;
  sortDir: PlaylistSortDir;
  setSortDir: React.Dispatch<React.SetStateAction<PlaylistSortDir>>;
  sortClickCount: number;
  setSortClickCount: React.Dispatch<React.SetStateAction<number>>;

  // Selection
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  allSelected: boolean;
  toggleAll: () => void;
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
  showBulkPlPicker: boolean;
  setShowBulkPlPicker: React.Dispatch<React.SetStateAction<boolean>>;
  bulkRemove: () => void;

  // Context menu + DnD visual
  contextMenuSongId: string | null;
  setContextMenuSongId: React.Dispatch<React.SetStateAction<string | null>>;
  dropTargetIdx: { idx: number; before: boolean } | null;

  // Rating / star / row mouse / delete
  ratings: Record<string, number>;
  starredSongs: Set<string>;
  handleRate: (songId: string, rating: number) => void;
  handleToggleStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  handleRowMouseDown: (e: React.MouseEvent, idx: number) => void;
  handleRowMouseEnter: (idx: number, e: React.MouseEvent) => void;
  removeSong: (idx: number) => void;

  // Empty state
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function PlaylistTracklist({
  allColumns, visibleCols, gridStyle, colVisible, toggleColumn, resetColumns,
  pickerOpen, setPickerOpen, pickerRef, startResize, tracklistRef,
  songs, displayedSongs, displayedTracks, isFiltered, hasActiveFilter, id,
  sortKey, setSortKey, sortDir, setSortDir, sortClickCount, setSortClickCount,
  selectedIds, setSelectedIds, allSelected, toggleAll, toggleSelect,
  showBulkPlPicker, setShowBulkPlPicker, bulkRemove,
  contextMenuSongId, setContextMenuSongId, dropTargetIdx,
  ratings, starredSongs, handleRate, handleToggleStar,
  handleRowMouseDown, handleRowMouseEnter, removeSong,
  setSearchOpen,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const showBitrate = useThemeStore(s => s.showBitrate);
  const { isDragging } = useDragDrop();
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  const latestVals = {
    selectedIds, orbitActive, displayedTracks, isFiltered, id,
    toggleSelect, handleRowMouseDown, handleRowMouseEnter, handleToggleStar,
    handleRate, removeSong, playTrack, openContextMenu, setContextMenuSongId,
    navigate, queueHint, addTrackToOrbit,
  };
  const latest = useRef(latestVals);
  latest.current = latestVals;

  const cb = useMemo<PlaylistRowCallbacks>(() => ({
    activate: (song, index, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const L = latest.current;
      if (e.ctrlKey || e.metaKey) L.toggleSelect(song.id, index, false);
      else if (L.selectedIds.size > 0) L.toggleSelect(song.id, index, e.shiftKey);
      else if (L.orbitActive) L.queueHint();
      else L.playTrack(L.displayedTracks[index], L.displayedTracks);
    },
    dblOrbit: (songId, e) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      const L = latest.current;
      if (e.ctrlKey || e.metaKey || L.selectedIds.size > 0) return;
      L.addTrackToOrbit(songId);
    },
    context: (song, rIdx, e) => {
      e.preventDefault();
      const L = latest.current;
      L.setContextMenuSongId(song.id);
      L.openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song', undefined, L.id, rIdx);
    },
    mouseDownRow: (rIdx, e) => latest.current.handleRowMouseDown(e, rIdx),
    mouseEnterRow: (index, e) => { const L = latest.current; if (!L.isFiltered) L.handleRowMouseEnter(index, e); },
    toggleSelect: (songId, index, shift) => latest.current.toggleSelect(songId, index, shift),
    play: (index) => {
      const L = latest.current;
      if (L.orbitActive) { L.queueHint(); return; }
      L.playTrack(L.displayedTracks[index], L.displayedTracks);
    },
    startPreview: (song) => usePreviewStore.getState().startPreview(
      { id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration },
      'playlists',
    ),
    toggleStar: (song, e) => latest.current.handleToggleStar(song, e),
    rate: (songId, r) => latest.current.handleRate(songId, r),
    remove: (rIdx) => latest.current.removeSong(rIdx),
    navArtist: (artistId) => latest.current.navigate(`/artist/${artistId}`),
    navAlbum: (albumId) => latest.current.navigate(`/album/${albumId}`),
  }), []);

  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const viewportH = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);

  useLayoutEffect(() => {
    const sc = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    const root = tracklistRef.current?.closest('.album-detail') as HTMLElement | null;
    if (!sc) return;
    const measure = () => {
      const wrap = listWrapRef.current;
      if (!wrap) return;
      const m = wrap.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      setScrollMargin(prev => (Math.abs(prev - m) > 0.5 ? m : prev));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    if (root) ro.observe(root);
    measure();
    return () => ro.disconnect();
  }, [tracklistRef, selectedIds.size > 0, pickerOpen, displayedSongs.length]);

  const rowVirtualizer = useVirtualizer({
    count: displayedSongs.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: () => 48,
    overscan: Math.max(8, Math.ceil(viewportH / 48)),
    scrollMargin,
    getItemKey: i => `${displayedSongs[i].id}:${i}`,
  });

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const sc = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (sc) sc.scrollTop = scrollMargin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, hasActiveFilter]);

  const autoScrollRef = useRef(0);
  const pointerYRef = useRef(0);
  const runAutoScroll = useCallback(() => {
    const sc = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (!sc) { autoScrollRef.current = 0; return; }
    const r = sc.getBoundingClientRect();
    const EDGE = 60;
    const MAX = 18;
    const y = pointerYRef.current;
    let dy = 0;
    if (y < r.top + EDGE) dy = -MAX * (1 - (y - r.top) / EDGE);
    else if (y > r.bottom - EDGE) dy = MAX * (1 - (r.bottom - y) / EDGE);
    if (dy !== 0) sc.scrollTop += dy;
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => { pointerYRef.current = e.clientY; };
    window.addEventListener('mousemove', onMove);
    autoScrollRef.current = requestAnimationFrame(runAutoScroll);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = 0;
    };
  }, [isDragging, runAutoScroll]);

  const virtualItems = rowVirtualizer.getVirtualItems();

  let dropIndicatorY: number | null = null;
  if (isDragging && !isFiltered && dropTargetIdx) {
    const vi = virtualItems.find(v => v.index === dropTargetIdx.idx);
    const start = vi ? vi.start : dropTargetIdx.idx * 48 + scrollMargin;
    const size = vi ? vi.size : 48;
    dropIndicatorY = (dropTargetIdx.before ? start : start + size) - scrollMargin;
  }

  return (
    <>
      <TracklistColumnPicker
        allColumns={allColumns}
        pickerRef={pickerRef}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
        colVisible={colVisible}
        toggleColumn={toggleColumn}
        resetColumns={resetColumns}
        t={t}
      />
    <div className="tracklist" data-preview-loc="playlists" ref={tracklistRef}>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="bulk-action-bar">
          <span className="bulk-action-count">
            {t('common.bulkSelected', { count: selectedIds.size })}
          </span>
          <div className="bulk-pl-picker-wrap">
            <button
              className="btn btn-surface btn-sm"
              onClick={() => setShowBulkPlPicker(v => !v)}
            >
              <ListPlus size={14} />
              {t('common.bulkAddToPlaylist')}
            </button>
            {showBulkPlPicker && (
              <AddToPlaylistSubmenu
                songIds={[...selectedIds]}
                onDone={() => { setShowBulkPlPicker(false); setSelectedIds(new Set()); }}
                dropDown
              />
            )}
          </div>
          <button
            className="btn btn-surface btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={bulkRemove}
          >
            <Trash2 size={14} />
            {t('common.bulkRemoveFromPlaylist')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedIds(new Set())}
          >
            <X size={13} />
            {t('common.bulkClear')}
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ position: 'relative' }}>
        <div className="tracklist-header tracklist-va" style={gridStyle}>
          {visibleCols.map((colDef, colIndex) => {
            const key = colDef.key;
            const isLastCol = colIndex === visibleCols.length - 1;
            const isCentered = PL_CENTERED.has(key);
            const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
            const sortableCols = new Set(['title', 'artist', 'favorite', 'rating', 'duration', 'album']);
            const canSort = sortableCols.has(key);
            const isSortActive = canSort && sortKey === key;

            const handleSortClick = () => {
              if (!canSort) return;
              if (sortKey === key) {
                const nextCount = sortClickCount + 1;
                if (nextCount >= 3) {
                  setSortKey('natural');
                  setSortDir('asc');
                  setSortClickCount(0);
                } else {
                  setSortDir(d => d === 'asc' ? 'desc' : 'asc');
                  setSortClickCount(nextCount);
                }
              } else {
                setSortKey(key as PlaylistSortKey);
                setSortDir('asc');
                setSortClickCount(1);
              }
            };

            const renderSortIndicator = () => {
              if (!isSortActive) return null;
              return (
                <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                  {sortDir === 'asc' ? '▲' : '▼'}
                </span>
              );
            };

            if (key === 'num') return (
              <div key="num" className="track-num">
                <span
                  className={`bulk-check${allSelected ? ' checked' : ''}${selectedIds.size > 0 ? ' bulk-check-visible' : ''}`}
                  onClick={e => { e.stopPropagation(); toggleAll(); }}
                  style={{ cursor: 'pointer' }}
                />
                <span className="track-num-number">#</span>
              </div>
            );
            if (key === 'title') {
              const hasNextCol = colIndex + 1 < visibleCols.length;
              return (
                <div
                  key="title"
                  onClick={handleSortClick}
                  style={{
                    position: 'relative',
                    padding: 0,
                    margin: 0,
                    minWidth: 0,
                    overflow: 'hidden',
                    cursor: canSort ? 'pointer' : 'default',
                    userSelect: 'none',
                  }}
                  className={isSortActive ? 'tracklist-header-cell-active' : ''}
                >
                  <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 12 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSortActive ? 600 : 400 }}>{label}</span>
                    {canSort && renderSortIndicator()}
                  </div>
                  {hasNextCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />}
                </div>
              );
            }
            if (key === 'delete') return <div key="delete" />;
            return (
              <div
                key={key}
                onClick={handleSortClick}
                style={{
                  position: 'relative',
                  padding: 0,
                  margin: 0,
                  minWidth: 0,
                  overflow: 'hidden',
                  cursor: canSort ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
                className={isSortActive ? 'tracklist-header-cell-active' : ''}
              >
                <div
                  style={{
                    display: 'flex',
                    width: '100%',
                    height: '100%',
                    alignItems: 'center',
                    justifyContent: isCentered ? 'center' : 'flex-start',
                    paddingLeft: isCentered ? 0 : 12,
                  }}
                >
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isSortActive ? 600 : 400 }}>{label}</span>
                  {canSort && renderSortIndicator()}
                </div>
                {!isLastCol && key !== 'delete' && (
                  <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {songs.length === 0 && (
        <div className="empty-state" style={{ padding: '2rem 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <span>{t('playlists.emptyPlaylist')}</span>
          <button className="btn btn-primary" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            {t('playlists.addFirstSong')}
          </button>
        </div>
      )}

      <div ref={listWrapRef} style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
      {dropIndicatorY !== null && (
        <div
          className="playlist-drop-indicator"
          style={{ position: 'absolute', left: 0, right: 0, top: dropIndicatorY, pointerEvents: 'none' }}
        />
      )}
      {virtualItems.map(vi => {
        const song = displayedSongs[vi.index];
        const i = vi.index;
        const realIdx = isFiltered ? songs.indexOf(song) : i;
        return (
        <div
          key={vi.key}
          data-index={i}
          ref={rowVirtualizer.measureElement}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start - scrollMargin}px)` }}
        >
          <PlaylistRow
            song={song}
            index={i}
            realIdx={realIdx}
            visibleCols={visibleCols}
            gridStyle={gridStyle}
            showBitrate={showBitrate}
            isActive={currentTrack?.id === song.id}
            showEq={currentTrack?.id === song.id && isPlaying}
            isContextActive={contextMenuSongId === song.id}
            isSelected={selectedIds.has(song.id)}
            inSelectMode={selectedIds.size > 0}
            isStarred={song.id in starredOverrides ? !!starredOverrides[song.id] : starredSongs.has(song.id)}
            ratingValue={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0}
            isPreviewing={previewingId === song.id}
            previewStarted={previewingId === song.id && previewAudioStarted}
            orbitActive={orbitActive}
            cb={cb}
          />
        </div>
        );
      })}
      </div>


    </div>
    </>
  );
}
