import React from 'react';
import { AudioLines, ChevronRight, Heart, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { useSelectionStore } from '@/store/selectionStore';
import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';
import { previewInputFromSong, usePreviewStore } from '@/features/playback/store/previewStore';
import StarRating from '@/ui/StarRating';
import { codecLabel, type ColKey } from '@/features/album/utils/albumTrackListHelpers';
import { formatLongDuration } from '@/lib/format/formatDuration';
import { formatLastSeen } from '@/lib/format/userMgmtHelpers';
import i18n from '@/lib/i18n';
import { offlineActionPolicy, type OfflineActionPolicy } from '@/features/offline';
import { resolveTrackArtistRefs } from '@/features/playback/utils/playback/trackArtistRefs';
import { buildArtistDetailPath } from '@/lib/navigation/detailServerScope';
import { ResolvedArtistRefInline } from '@/ui/ResolvedArtistRefInline';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';
import { sameQueueTrack } from '@/features/playback';

type ContextMenuFn = (
  x: number,
  y: number,
  track: Track,
  type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song',
) => void;

interface TrackRowProps {
  song: SubsonicSong;
  globalIdx: number;
  visibleCols: readonly ColDef[];
  gridStyle: React.CSSProperties;
  currentTrack: Track | null;
  isPlaying: boolean;
  ratingValue: number;
  isStarred: boolean;
  inSelectMode: boolean;
  isContextMenuSong: boolean;
  onPlaySong: (song: SubsonicSong) => void;
  onDoubleClickSong?: (song: SubsonicSong) => void;
  onRate: (song: SubsonicSong, rating: number) => void;
  onToggleSongStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  onContextMenu: ContextMenuFn;
  onToggleSelect: (id: string, globalIdx: number, shift: boolean) => void;
  onDragStart: (song: SubsonicSong, me: MouseEvent) => void;
  setContextMenuSongKey: (id: string | null) => void;
  actionPolicy?: OfflineActionPolicy;
}

/**
 * Artist cell of a tracklist row. Its own component because resolving the credits
 * needs hooks, which cannot live inside the column `switch`.
 *
 * A credit split out of a joined string ("A feat. B") carries no id of its own; the
 * ids are looked up in the local index so every artist is clickable, not just the
 * primary one. Names with no artist row stay plain text.
 */
const TrackArtistCell = React.memo(function TrackArtistCell({ song }: { song: SubsonicSong }) {
  const navigate = useNavigate();
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');
  const baseRefs = React.useMemo(() => resolveTrackArtistRefs(song), [song]);
  return (
    <div className="track-artist-cell">
      <ResolvedArtistRefInline
        refs={baseRefs}
        // `song.serverId` is only stamped on owned/multi-server rows.
        serverId={song.serverId ?? activeServerId}
        fallbackName={song.artist}
        onGoArtist={id => navigate(buildArtistDetailPath(id, { serverId: song.serverId }))}
        as="none"
        linkTag="span"
        plainClassName="track-artist"
        linkClassName="track-artist-link"
        separatorClassName="track-artist-sep"
      />
    </div>
  );
});

/**
 * Memoised tracklist row. Subscribes to its own selection + preview state
 * via primitive selectors so only this row re-renders when the user
 * toggles selection or starts/stops a preview.
 */
export const TrackRow = React.memo(function TrackRow({
  song,
  globalIdx,
  visibleCols,
  gridStyle,
  currentTrack,
  isPlaying,
  ratingValue,
  isStarred,
  inSelectMode,
  isContextMenuSong,
  onPlaySong,
  onDoubleClickSong,
  onRate,
  onToggleSongStar,
  onContextMenu,
  onToggleSelect,
  onDragStart,
  setContextMenuSongKey,
  actionPolicy,
}: TrackRowProps) {
  const policy = actionPolicy ?? offlineActionPolicy('trackRow', false);
  const { t } = useTranslation();
  const showBitrate = useThemeStore(s => s.showBitrate);
  const songKey = ownedEntityKey(song);
  const isSelected = useSelectionStore(s => s.selectedIds.has(songKey));
  const isActive = sameQueueTrack(currentTrack, song);
  const isPreviewing = usePreviewStore(s => sameQueueTrack(s.previewingTrack, song));
  const isPreviewAudioStarted = usePreviewStore(s => sameQueueTrack(s.previewingTrack, song) && s.audioStarted);

  const renderCell = (colDef: ColDef) => {
    const key = colDef.key as ColKey;
    switch (key) {
      case 'num':
        return (
          <div
            key="num"
            className={`track-num${isActive ? ' track-num-active' : ''}`}
          >
            <span
              className={`bulk-check${isSelected ? ' checked' : ''}${inSelectMode ? ' bulk-check-visible' : ''}`}
              onClick={e => { e.stopPropagation(); onToggleSelect(songKey, globalIdx, e.shiftKey); }}
            />
            {isActive && isPlaying ? (
              <span className="track-num-eq">
                <AudioLines className="eq-bars" size={14} />
              </span>
            ) : (
              <span className="track-num-number">{song.track ?? '—'}</span>
            )}
          </div>
        );
      case 'title':
        return (
          <div key="title" className="track-info track-info-suggestion">
            <button
              type="button"
              className="playlist-suggestion-play-btn"
              onClick={e => { e.stopPropagation(); onPlaySong(song); }}
              onDoubleClick={onDoubleClickSong ? e => { e.stopPropagation(); onDoubleClickSong(song); } : undefined}
              data-tooltip={t('common.play')}
              aria-label={t('common.play')}
            >
              <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
            </button>
            <button
              type="button"
              className={`playlist-suggestion-preview-btn${isPreviewing ? ' is-previewing' : ''}${isPreviewAudioStarted ? ' audio-started' : ''}`}
              onClick={e => {
                e.stopPropagation();
                usePreviewStore.getState().startPreview(previewInputFromSong(song), 'albums');
              }}
              data-tooltip={isPreviewing ? t('playlists.previewStop') : t('playlists.preview')}
              aria-label={isPreviewing ? t('playlists.previewStop') : t('playlists.preview')}
            >
              <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
              </svg>
              {isPreviewing
                ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
            </button>
            <span className="track-title">{song.title}</span>
          </div>
        );
      case 'artist':
        return <TrackArtistCell key="artist" song={song} />;
      case 'favorite':
        return (
          <div key="favorite" className="track-star-cell">
            <button
              className={`btn btn-ghost track-star-btn${isStarred ? ' is-starred' : ''}`}
              onClick={e => onToggleSongStar(song, e)}
              data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
            >
              <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
            </button>
          </div>
        );
      case 'rating':
        return (
          <StarRating
            key="rating"
            value={ratingValue}
            onChange={r => onRate(song, r)}
            disabled={!policy.canRate}
          />
        );
      case 'duration':
        return (
          <div key="duration" className="track-duration">
            {formatLongDuration(song.duration)}
          </div>
        );
      case 'format':
        return (
          <div key="format" className="track-meta">
            {(song.suffix || (showBitrate && song.bitRate)) && (
              <span className="track-codec">{codecLabel(song, showBitrate)}</span>
            )}
          </div>
        );
      case 'genre':
        return (
          <div key="genre" className="track-genre">
            {song.genre ?? '—'}
          </div>
        );
      case 'playCount':
        return (
          <div key="playCount" className="track-duration">
            {song.playCount ?? '—'}
          </div>
        );
      case 'lastPlayed':
        return (
          <div key="lastPlayed" className="track-genre">
            {song.played ? formatLastSeen(song.played, i18n.language, '—') : '—'}
          </div>
        );
      case 'bpm':
        return (
          <div key="bpm" className="track-duration">
            {song.bpm && song.bpm > 0 ? song.bpm : '—'}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`track-row track-row-va track-row-with-actions${isActive ? ' active' : ''}${isContextMenuSong ? ' context-active' : ''}${isSelected ? ' bulk-selected' : ''}`}
      style={gridStyle}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (e.ctrlKey || e.metaKey) {
          onToggleSelect(songKey, globalIdx, false);
        } else if (inSelectMode) {
          onToggleSelect(songKey, globalIdx, e.shiftKey);
        } else {
          onPlaySong(song);
        }
      }}
      onDoubleClick={onDoubleClickSong ? e => {
        if ((e.target as HTMLElement).closest('button, a, input')) return;
        if (e.ctrlKey || e.metaKey || inSelectMode) return;
        onDoubleClickSong(song);
      } : undefined}
      onContextMenu={e => {
        e.preventDefault();
        setContextMenuSongKey(songKey);
        onContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
      }}
      role="row"
      onMouseDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            onDragStart(song, me);
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      {visibleCols.map(colDef => renderCell(colDef))}
    </div>
  );
});
