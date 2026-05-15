import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  AudioLines, Check, ChevronDown, ChevronRight, ListPlus, Play, RotateCcw,
  Square, X,
} from 'lucide-react';
import type { ColDef } from '../../utils/useTracklistColumns';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import { usePreviewStore } from '../../store/previewStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useDragDrop } from '../../contexts/DragDropContext';
import { useOrbitSongRowBehavior } from '../../hooks/useOrbitSongRowBehavior';
import { songToTrack } from '../../utils/playback/songToTrack';
import { formatTrackTime } from '../../utils/format/formatDuration';
import { formatLastSeen } from '../../utils/componentHelpers/userMgmtHelpers';
import i18n from '../../i18n';
import { AddToPlaylistSubmenu } from '../ContextMenu';
import StarRating from '../StarRating';

const SORTABLE_COLUMNS = new Set(['title', 'artist', 'album', 'rating', 'duration', 'playCount', 'lastPlayed', 'bpm']);

interface Props {
  visibleSongs: SubsonicSong[];
  selectedIds: Set<string>;
  selectedCount: number;
  inSelectMode: boolean;
  toggleSelect: (id: string, idx: number, shift: boolean) => void;
  showPlPicker: boolean;
  setShowPlPicker: React.Dispatch<React.SetStateAction<boolean>>;
  allColumns: readonly ColDef[];
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  colVisible: Set<string>;
  toggleColumn: (key: string) => void;
  resetColumns: () => void;
  pickerOpen: boolean;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  tracklistRef: React.RefObject<HTMLDivElement | null>;
  startResize: (e: React.MouseEvent, colIndex: number, direction?: 1 | -1) => void;
  handleSortClick: (key: string) => void;
  getSortIndicator: (key: string) => React.ReactNode;
  ratings: Record<string, number>;
  handleRate: (songId: string, rating: number) => void;
  removeSong: (id: string) => void;
  hasFilters: boolean;
}

export default function FavoritesSongsTracklist({
  visibleSongs, selectedIds, selectedCount, inSelectMode, toggleSelect,
  showPlPicker, setShowPlPicker,
  allColumns, visibleCols, gridStyle, colVisible, toggleColumn, resetColumns,
  pickerOpen, setPickerOpen, pickerRef, tracklistRef,
  startResize, handleSortClick, getSortIndicator,
  ratings, handleRate, removeSong, hasFilters,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const psyDrag = useDragDrop();
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();

  return (
    <div className="tracklist" data-preview-loc="favorites" style={{ padding: 0 }} ref={tracklistRef} onClick={e => {
      if (inSelectMode && e.target === e.currentTarget) useSelectionStore.getState().clearAll();
    }}>

      {/* ── Bulk action bar ── */}
      {inSelectMode && (
        <div className="bulk-action-bar">
          <span className="bulk-action-count">
            {t('common.bulkSelected', { count: selectedCount })}
          </span>
          <div className="bulk-pl-picker-wrap">
            <button
              className="btn btn-surface btn-sm"
              onClick={() => setShowPlPicker(v => !v)}
            >
              <ListPlus size={14} />
              {t('common.bulkAddToPlaylist')}
            </button>
            {showPlPicker && (
              <AddToPlaylistSubmenu
                songIds={[...useSelectionStore.getState().selectedIds]}
                onDone={() => { setShowPlPicker(false); useSelectionStore.getState().clearAll(); }}
                dropDown
              />
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => useSelectionStore.getState().clearAll()}
          >
            <X size={13} />
            {t('common.bulkClear')}
          </button>
        </div>
      )}

      {/* Column visibility picker */}
      <div className="tracklist-col-picker-wrapper" ref={pickerRef}>
        <div className="tracklist-col-picker">
          <button className="tracklist-col-picker-btn" onClick={e => { e.stopPropagation(); setPickerOpen(v => !v); }} data-tooltip={t('albumDetail.columns')}>
            <ChevronDown size={14} />
          </button>
          {pickerOpen && (
            <div className="tracklist-col-picker-menu">
              <div className="tracklist-col-picker-label">{t('albumDetail.columns')}</div>
              {allColumns.filter(c => !c.required).map(c => {
                const label = c.i18nKey ? t(`albumDetail.${c.i18nKey}`) : c.key;
                const isOn = colVisible.has(c.key);
                return (
                  <button key={c.key} className={`tracklist-col-picker-item${isOn ? ' active' : ''}`} onClick={() => toggleColumn(c.key)}>
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

      <div style={{ position: 'relative' }}>
        <div className="tracklist-header tracklist-va" style={gridStyle}>
          {visibleCols.map((colDef, colIndex) => {
            const key = colDef.key;
            const isLastCol = colIndex === visibleCols.length - 1;
            const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
            if (key === 'num') {
              const allSelected = selectedCount === visibleSongs.length && visibleSongs.length > 0;
              return (
                <div key="num" className="track-num">
                  <span
                    className={`bulk-check${allSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={e => {
                      e.stopPropagation();
                      if (allSelected) {
                        useSelectionStore.getState().clearAll();
                      } else {
                        useSelectionStore.getState().setSelectedIds(() => new Set(visibleSongs.map(s => s.id)));
                      }
                    }}
                  />
                  <span className="track-num-number">#</span>
                </div>
              );
            }
            if (key === 'title') {
              const hasNextCol = colIndex + 1 < visibleCols.length;
              const canSort = SORTABLE_COLUMNS.has('title');
              return (
                <div key="title" style={{ position: 'relative', padding: 0, margin: 0, minWidth: 0, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'flex',
                      width: '100%',
                      height: '100%',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      paddingLeft: 12,
                      cursor: canSort ? 'pointer' : 'default',
                      userSelect: 'none',
                    }}
                    onClick={() => handleSortClick('title')}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                    {canSort && getSortIndicator('title')}
                  </div>
                  {hasNextCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex + 1, -1)} />}
                </div>
              );
            }
            if (key === 'remove') return <div key="remove" />;

            const isCentered = key === 'duration' || key === 'rating';
            const canSort = SORTABLE_COLUMNS.has(key);

            return (
              <div key={key} style={{ position: 'relative', padding: 0, margin: 0, minWidth: 0, overflow: 'hidden' }}>
                <div
                  style={{
                    display: 'flex',
                    width: '100%',
                    height: '100%',
                    alignItems: 'center',
                    justifyContent: isCentered ? 'center' : 'flex-start',
                    paddingLeft: isCentered ? 0 : 12,
                    cursor: canSort ? 'pointer' : 'default',
                    userSelect: 'none',
                  }}
                  onClick={() => canSort && handleSortClick(key)}
                >
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  {canSort && getSortIndicator(key)}
                </div>
                {!isLastCol && <div className="col-resize-handle" onMouseDown={e => startResize(e, colIndex, 1)} />}
              </div>
            );
          })}
        </div>
      </div>
      {visibleSongs.map((song, i) => {
        const track = songToTrack(song);
        const isSelected = selectedIds.has(song.id);
        return (
          <div
            key={song.id}
            className={`track-row track-row-va track-row-with-actions${currentTrack?.id === song.id ? ' active' : ''}${isSelected ? ' bulk-selected' : ''}`}
            style={gridStyle}
            onClick={e => {
              if ((e.target as HTMLElement).closest('button, a, input')) return;
              if (e.ctrlKey || e.metaKey) {
                toggleSelect(song.id, i, false);
              } else if (inSelectMode) {
                toggleSelect(song.id, i, e.shiftKey);
              } else if (orbitActive) {
                queueHint();
              } else {
                playTrack(track, visibleSongs.map(songToTrack));
              }
            }}
            onDoubleClick={orbitActive ? e => {
              if ((e.target as HTMLElement).closest('button, a, input')) return;
              if (e.ctrlKey || e.metaKey || inSelectMode) return;
              addTrackToOrbit(song.id);
            } : undefined}
            onContextMenu={e => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, track, 'favorite-song'); }}
            role="row"
            onMouseDown={e => {
              if (e.button !== 0) return;
              e.preventDefault();
              const sx = e.clientX, sy = e.clientY;
              const onMove = (me: MouseEvent) => {
                if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  const { selectedIds: selIds } = useSelectionStore.getState();
                  if (selIds.has(song.id) && selIds.size > 1) {
                    const bulkTracks = visibleSongs.filter(s => selIds.has(s.id)).map(songToTrack);
                    psyDrag.startDrag({ data: JSON.stringify({ type: 'songs', tracks: bulkTracks }), label: `${bulkTracks.length} Songs` }, me.clientX, me.clientY);
                  } else {
                    psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
                  }
                }
              };
              const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          >
            {visibleCols.map(colDef => {
              switch (colDef.key) {
                case 'num': return (
                  <div key="num" className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`}>
                    <span className={`bulk-check${isSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`} onClick={e => { e.stopPropagation(); toggleSelect(song.id, i, e.shiftKey); }} />
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
                      onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(track, visibleSongs.map(songToTrack)); }}
                      data-tooltip={t('common.play')}
                      aria-label={t('common.play')}
                    >
                      <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                    </button>
                    <button
                      type="button"
                      className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                      onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'favorites'); }}
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
                    <span className={`track-artist${song.artistId ? ' track-artist-link' : ''}`} style={{ cursor: song.artistId ? 'pointer' : 'default' }} onClick={() => song.artistId && navigate(`/artist/${song.artistId}`)}>{song.artist}</span>
                  </div>
                );
                case 'album': return (
                  <div key="album" className="track-artist-cell">
                    {song.albumId ? (
                      <span
                        className="track-artist track-artist-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/album/${song.albumId}`);
                        }}
                      >
                        {song.album}
                      </span>
                    ) : (
                      <span className="track-artist">{song.album}</span>
                    )}
                  </div>
                );
                case 'genre': return (
                  <div key="genre" className="track-genre">
                    {song.genre ?? '—'}
                  </div>
                );
                case 'format': return (
                  <div key="format" className="track-meta">
                    {(song.suffix || song.bitRate) && (
                      <span className="track-codec">
                        {song.suffix?.toUpperCase()}
                        {song.suffix && song.bitRate && ' · '}
                        {song.bitRate && `${song.bitRate} kbps`}
                      </span>
                    )}
                  </div>
                );
                case 'rating': return (
                  <StarRating
                    key="rating"
                    value={ratings[song.id] ?? userRatingOverrides[song.id] ?? song.userRating ?? 0}
                    onChange={r => handleRate(song.id, r)}
                  />
                );
                case 'duration': return (
                  <div key="duration" className="track-duration">
                    {formatTrackTime(song.duration)}
                  </div>
                );
                case 'playCount': return (
                  <div key="playCount" className="track-duration">{song.playCount ?? '—'}</div>
                );
                case 'lastPlayed': return (
                  <div key="lastPlayed" className="track-genre">{song.played ? formatLastSeen(song.played, i18n.language, '—') : '—'}</div>
                );
                case 'bpm': return (
                  <div key="bpm" className="track-duration">{song.bpm && song.bpm > 0 ? song.bpm : '—'}</div>
                );
                case 'remove': return (
                  <div key="remove" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <button className="btn-icon fav-remove-btn" data-tooltip={t('favorites.removeSong')} onClick={e => { e.stopPropagation(); removeSong(song.id); }} aria-label={t('favorites.removeSong')}>
                      <X size={14} />
                    </button>
                  </div>
                );
                default: return null;
              }
            })}
          </div>
        );
      })}

      {/* Empty state when filters return no results */}
      {visibleSongs.length === 0 && hasFilters && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>
          {t('favorites.noFilterResults')}
        </div>
      )}
    </div>
  );
}
