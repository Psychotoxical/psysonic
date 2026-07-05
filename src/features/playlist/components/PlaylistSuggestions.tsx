import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Heart, Play, Plus, RefreshCw, Square } from 'lucide-react';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';
import StarRating from '@/ui/StarRating';
import { PlaylistArtistCell } from '@/features/playlist/components/PlaylistArtistCell';
import { useThemeStore } from '@/store/themeStore';
import { usePlaylistLayoutStore } from '@/features/playlist/store/playlistLayoutStore';
import { songToTrack } from '@/lib/media/songToTrack';
import { getQueueTracksView } from '@/features/playback/store/queueTrackView';
import { codecLabel } from '@/lib/format/playlistDetailHelpers';
import { formatLastSeen } from '@/lib/format/userMgmtHelpers';
import { formatTrackTime } from '@/lib/format/formatDuration';
import i18n from '@/lib/i18n';

const PL_CENTERED = new Set(['favorite', 'rating', 'duration', 'playCount', 'bpm']);

interface Props {
  songs: SubsonicSong[];
  suggestions: SubsonicSong[];
  existingIds: Set<string>;
  loadingSuggestions: boolean;
  loadSuggestions: (songs: SubsonicSong[]) => void;
  visibleCols: ColDef[];
  gridStyle: React.CSSProperties;
  contextMenuSongId: string | null;
  setContextMenuSongId: React.Dispatch<React.SetStateAction<string | null>>;
  hoveredSuggestionId: string | null;
  setHoveredSuggestionId: React.Dispatch<React.SetStateAction<string | null>>;
  addSong: (song: SubsonicSong) => void;
  startPreview: (song: SubsonicSong) => void;
  ratings: Record<string, number>;
  starredSongs: Set<string>;
  handleRate: (songId: string, rating: number) => void;
  handleToggleStar: (song: SubsonicSong, e: React.MouseEvent) => void;
}

export default function PlaylistSuggestions({
  songs, suggestions, existingIds,
  loadingSuggestions, loadSuggestions,
  visibleCols, gridStyle,
  contextMenuSongId, setContextMenuSongId,
  hoveredSuggestionId, setHoveredSuggestionId,
  addSong, startPreview,
  ratings, starredSongs, handleRate, handleToggleStar,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const showBitrate = useThemeStore(s => s.showBitrate);
  const suggestionsVisible = usePlaylistLayoutStore(s =>
    s.items.find(i => i.id === 'suggestions')?.visible !== false);

  if (!suggestionsVisible) return null;

  const filteredSuggestions = suggestions.filter(s => !existingIds.has(s.id));

  return (
    <div className="playlist-suggestions tracklist" data-preview-loc="suggestions">
      <div className="playlist-suggestions-header compact-action-bar">
        <div className="playlist-suggestions-title">
          <h2 className="section-title" style={{ marginBottom: 0 }}>{t('playlists.suggestions')}</h2>
          <span className="playlist-suggestions-hint">{t('playlists.suggestionsHint')}</span>
        </div>
        <button
          className="btn btn-surface"
          onClick={() => loadSuggestions(songs)}
          disabled={loadingSuggestions || songs.length === 0}
          aria-label={t('playlists.refreshSuggestions')}
          data-tooltip={t('playlists.refreshSuggestions')}
        >
          <RefreshCw size={14} className={loadingSuggestions ? 'spin-slow' : ''} />
          <span className="compact-btn-label">{t('playlists.refreshSuggestions')}</span>
        </button>
      </div>

      {!loadingSuggestions && filteredSuggestions.length === 0 && (
        <div className="empty-state" style={{ padding: '1.5rem 0', fontSize: '0.85rem' }}>{t('playlists.noSuggestions')}</div>
      )}

      {filteredSuggestions.length > 0 && (
        <>
          <div className="tracklist-header tracklist-va" style={{ ...gridStyle, marginTop: 'var(--space-3)' }}>
            {visibleCols.map((colDef) => {
              const key = colDef.key;
              const isCentered = PL_CENTERED.has(key);
              const label = colDef.i18nKey ? t(`albumDetail.${colDef.i18nKey}`) : '';
              if (key === 'num') return <div key="num" className="col-center">#</div>;
              if (key === 'title') return <div key="title" style={{ paddingLeft: 12 }}>{label}</div>;
              if (key === 'delete') return <div key="delete" />;
              return <div key={key} className={isCentered ? 'col-center' : ''} style={!isCentered ? { paddingLeft: 12 } : undefined}>{label}</div>;
            })}
          </div>

          {filteredSuggestions.map((song, idx) => {
            const isStarred = song.id in starredOverrides
              ? !!starredOverrides[song.id]
              : (starredSongs.has(song.id) || !!song.starred);
            const ratingValue = ratings[song.id]
              ?? userRatingOverrides[song.id]
              ?? song.userRating
              ?? 0;
            return (
            <div
              key={song.id}
              className={`track-row track-row-va track-row-with-actions tracklist-playlist${contextMenuSongId === song.id ? ' context-active' : ''}`}
              style={gridStyle}
              onMouseEnter={() => setHoveredSuggestionId(song.id)}
              onMouseLeave={() => setHoveredSuggestionId(null)}
              onDoubleClick={e => {
                if ((e.target as HTMLElement).closest('button, a, input')) return;
                addSong(song);
              }}
              onContextMenu={e => {
                e.preventDefault();
                setContextMenuSongId(song.id);
                openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
              }}
            >
              {visibleCols.map(colDef => {
                switch (colDef.key) {
                  case 'num': return <div key="num" className="track-num" style={{ color: 'var(--text-muted)' }}>{idx + 1}</div>;
                  case 'title': return (
                    <div key="title" className="track-info track-info-suggestion">
                      <button
                        className="playlist-suggestion-play-btn"
                        onClick={e => {
                          e.stopPropagation();
                          const { queueItems, queueIndex, currentTrack, playTrack } = usePlayerStore.getState();
                          const track = songToTrack(song);
                          if (!currentTrack || queueItems.length === 0) {
                            playTrack(track, [track]);
                            return;
                          }
                          // Thin-state: resolve the current queue, insert after
                          // the playing track, and play the inserted track.
                          const resolved = getQueueTracksView(queueItems);
                          const insertAt = Math.min(queueIndex + 1, resolved.length);
                          const newQueue = [
                            ...resolved.slice(0, insertAt),
                            track,
                            ...resolved.slice(insertAt),
                          ];
                          playTrack(track, newQueue, undefined, undefined, insertAt);
                        }}
                        data-tooltip={t('playlists.playNextSuggestion')}
                        aria-label={t('playlists.playNextSuggestion')}
                      >
                        <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                      </button>
                      <button
                        className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                        onClick={e => { e.stopPropagation(); startPreview(song); }}
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
                  case 'artist': return <PlaylistArtistCell key="artist" song={song} />;
                  case 'album': return (
                    <div key="album" className="track-artist-cell">
                      <span className={`track-artist${song.albumId ? ' track-artist-link' : ''}`} style={{ cursor: song.albumId ? 'pointer' : 'default' }} onClick={e => { if (song.albumId) { e.stopPropagation(); navigate(`/album/${song.albumId}`); } }}>{song.album}</span>
                    </div>
                  );
                  case 'favorite': return (
                    <div key="favorite" className="track-star-cell">
                      <button className="btn btn-ghost track-star-btn" onClick={e => handleToggleStar(song, e)} style={{ color: isStarred ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }} data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}>
                        <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  );
                  case 'rating': return <StarRating key="rating" value={ratingValue} onChange={r => handleRate(song.id, r)} />;
                  case 'duration': return <div key="duration" className="track-duration">{formatTrackTime(song.duration ?? 0)}</div>;
                  case 'format': return (
                    <div key="format" className="track-meta">
                      {(song.suffix || (showBitrate && song.bitRate)) && <span className="track-codec">{codecLabel(song, showBitrate)}</span>}
                    </div>
                  );
                  case 'genre': return (
                    <div key="genre" className="track-genre">{song.genre ?? '—'}</div>
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
                  case 'delete': return (
                    <div key="delete" className="playlist-row-delete-cell">
                      <button className="playlist-row-delete-btn" style={{ color: hoveredSuggestionId === song.id ? 'var(--accent)' : undefined }} onClick={e => { e.stopPropagation(); addSong(song); }} data-tooltip={t('playlists.addSong')} data-tooltip-pos="left">
                        <Plus size={13} />
                      </button>
                    </div>
                  );
                  default: return null;
                }
              })}
            </div>
            );
          })}
        </>
      )}
    </div>
  );
}
