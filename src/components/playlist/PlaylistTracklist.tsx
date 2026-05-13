import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  AudioLines, Check, ChevronDown, ChevronRight, Heart, ListPlus, Play, RotateCcw, Search, Square, Trash2, X,
} from 'lucide-react';
import type { ColDef } from '../../utils/useTracklistColumns';
import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
import { usePlayerStore } from '../../store/playerStore';
import { usePreviewStore } from '../../store/previewStore';
import { useThemeStore } from '../../store/themeStore';
import { useDragDrop } from '../../contexts/DragDropContext';
import { useOrbitSongRowBehavior } from '../../hooks/useOrbitSongRowBehavior';
import { songToTrack } from '../../utils/songToTrack';
import { codecLabel, formatDuration } from '../../utils/playlistDetailHelpers';
import type { PlaylistSortKey, PlaylistSortDir } from '../../utils/playlistDisplayedSongs';
import StarRating from '../StarRating';
import { AddToPlaylistSubmenu } from '../ContextMenu';

const PL_CENTERED = new Set(['favorite', 'rating', 'duration']);

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
  songs, displayedSongs, displayedTracks, isFiltered, id,
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

  return (
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

      {/* Column visibility picker */}
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
              {allColumns.filter(c => !c.required).map(c => {
                const label = c.i18nKey ? t(`albumDetail.${c.i18nKey}`) : c.key;
                const isOn = colVisible.has(c.key);
                return (
                  <button
                    key={c.key}
                    className={`tracklist-col-picker-item${isOn ? ' active' : ''}`}
                    onClick={() => toggleColumn(c.key)}
                  >
                    <span className="tracklist-col-picker-check">{isOn && <Check size={13} />}</span>
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

      {displayedSongs.map((song, i) => {
        const realIdx = isFiltered ? songs.indexOf(song) : i;
        return (
        <React.Fragment key={song.id + i}>
          {!isFiltered && isDragging && dropTargetIdx?.idx === i && dropTargetIdx.before && (
            <div className="playlist-drop-indicator" />
          )}
          <div
            data-track-idx={realIdx}
            className={`track-row track-row-va track-row-with-actions tracklist-playlist${currentTrack?.id === song.id ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}${selectedIds.has(song.id) ? ' bulk-selected' : ''}`}
            style={gridStyle}
            onMouseEnter={e => !isFiltered && handleRowMouseEnter(i, e)}
            onMouseDown={e => handleRowMouseDown(e, realIdx)}
            onClick={e => {
              if ((e.target as HTMLElement).closest('button, a, input')) return;
              if (e.ctrlKey || e.metaKey) {
                toggleSelect(song.id, i, false);
              } else if (selectedIds.size > 0) {
                toggleSelect(song.id, i, e.shiftKey);
              } else if (orbitActive) {
                queueHint();
              } else {
                playTrack(displayedTracks[i], displayedTracks);
              }
            }}
            onDoubleClick={orbitActive ? e => {
              if ((e.target as HTMLElement).closest('button, a, input')) return;
              if (e.ctrlKey || e.metaKey || selectedIds.size > 0) return;
              addTrackToOrbit(song.id);
            } : undefined}
            onContextMenu={e => {
              e.preventDefault();
              setContextMenuSongId(song.id);
              openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song', undefined, id, realIdx);
            }}
          >
            {visibleCols.map(colDef => {
              const inSelectMode = selectedIds.size > 0;
              switch (colDef.key) {
                case 'num': return (
                  <div key="num" className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`}>
                    <span className={`bulk-check${selectedIds.has(song.id) ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`} onClick={e => { e.stopPropagation(); toggleSelect(song.id, i, e.shiftKey); }} />
                    {currentTrack?.id === song.id && isPlaying ? (
                      <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
                    ) : (
                      <span className="track-num-number">{i + 1}</span>
                    )}
                  </div>
                );
                case 'title': return (
                  <div key="title" className="track-info track-info-suggestion">
                    <button
                      type="button"
                      className="playlist-suggestion-play-btn"
                      onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(displayedTracks[i], displayedTracks); }}
                      data-tooltip={t('common.play')}
                      aria-label={t('common.play')}
                    >
                      <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                    </button>
                    <button
                      type="button"
                      className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                      onClick={e => {
                        e.stopPropagation();
                        usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'playlists');
                      }}
                      data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                      aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                    >
                      <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                        <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
                      </svg>
                      {previewingId === song.id
                        ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                        : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
                    </button>
                    <span className="track-title">{song.title}</span>
                  </div>
                );
                case 'artist': return (
                  <div key="artist" className="track-artist-cell">
                    <span className={`track-artist${song.artistId ? ' track-artist-link' : ''}`} style={{ cursor: song.artistId ? 'pointer' : 'default' }} onClick={e => { if (song.artistId) { e.stopPropagation(); navigate(`/artist/${song.artistId}`); } }}>{song.artist}</span>
                  </div>
                );
                case 'album': return (
                  <div key="album" className="track-artist-cell">
                    <span className={`track-artist${song.albumId ? ' track-artist-link' : ''}`} style={{ cursor: song.albumId ? 'pointer' : 'default' }} onClick={e => { if (song.albumId) { e.stopPropagation(); navigate(`/album/${song.albumId}`); } }}>{song.album}</span>
                  </div>
                );
                case 'favorite': return (
                  <div key="favorite" className="track-star-cell">
                    <button className="btn btn-ghost track-star-btn" onClick={e => handleToggleStar(song, e)} style={{ color: (song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}>
                      <Heart size={14} fill={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                );
                case 'rating': return <StarRating key="rating" value={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0} onChange={r => handleRate(song.id, r)} />;
                case 'duration': return <div key="duration" className="track-duration">{formatDuration(song.duration ?? 0)}</div>;
                case 'format': return (
                  <div key="format" className="track-meta">
                    {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
                  </div>
                );
                case 'delete': return (
                  <div key="delete" className="playlist-row-delete-cell">
                    <button className="playlist-row-delete-btn" onClick={e => { e.stopPropagation(); removeSong(realIdx); }} data-tooltip={t('playlists.removeSong')} data-tooltip-pos="left">
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
                default: return null;
              }
            })}
          </div>
          {!isFiltered && isDragging && dropTargetIdx?.idx === i && !dropTargetIdx.before && (
            <div className="playlist-drop-indicator" />
          )}
        </React.Fragment>
        );
      })}


    </div>
  );
}
