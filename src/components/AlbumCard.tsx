import React, { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, HardDriveDownload, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SubsonicAlbum, buildCoverArtUrl, coverArtCacheKey, getAlbum } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useAuthStore } from '../store/authStore';
import CachedImage from './CachedImage';
import { playAlbum } from '../utils/playAlbum';
import { useDragDrop } from '../contexts/DragDropContext';
import { isAlbumRecentlyAdded } from '../utils/albumRecency';

interface AlbumCardProps {
  album: SubsonicAlbum;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelect?: (id: string) => void;
  showRating?: boolean;
  selectedAlbums?: SubsonicAlbum[];
  disableArtwork?: boolean;
  artworkSize?: number;
}

function AlbumCard({
  album,
  selected,
  selectionMode,
  onToggleSelect,
  showRating = false,
  selectedAlbums = [],
  disableArtwork = false,
  artworkSize = 300,
}: AlbumCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const isOffline = useOfflineStore(s => {
    const meta = s.albums[`${serverId}:${album.id}`];
    if (!meta || meta.trackIds.length === 0) return false;
    return meta.trackIds.every(tid => !!s.tracks[`${serverId}:${tid}`]);
  });
  // buildCoverArtUrl emits a salted URL; memoize to avoid churn on rerenders.
  const coverUrl = useMemo(
    () => (album.coverArt ? buildCoverArtUrl(album.coverArt, artworkSize) : ''),
    [album.coverArt, artworkSize],
  );
  const coverCacheKey = useMemo(
    () => (album.coverArt ? coverArtCacheKey(album.coverArt, artworkSize) : ''),
    [album.coverArt, artworkSize],
  );
  const psyDrag = useDragDrop();
  const isNewAlbum = isAlbumRecentlyAdded(album.created);

  const handleClick = () => {
    if (selectionMode) { onToggleSelect?.(album.id); return; }
    navigate(`/album/${album.id}`);
  };

  return (
    <div
      className={`album-card card${selectionMode ? ' album-card--selectable' : ''}${selected ? ' album-card--selected' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`${album.name} von ${album.artist}`}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      onContextMenu={(e) => {
        e.preventDefault();
        if (selectionMode && selectedAlbums.length > 0) {
          openContextMenu(e.clientX, e.clientY, selectedAlbums, 'multi-album');
        } else {
          openContextMenu(e.clientX, e.clientY, album, 'album');
        }
      }}
      onMouseDown={e => {
        if (selectionMode || e.button !== 0) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const onMove = (me: MouseEvent) => {
          if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            psyDrag.startDrag({ data: JSON.stringify({ type: 'album', id: album.id, name: album.name }), label: album.name, coverUrl: coverUrl || undefined }, me.clientX, me.clientY);
          }
        };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    >
      <div className="album-card-cover">
        {!disableArtwork && coverUrl ? (
          <CachedImage
            src={coverUrl}
            cacheKey={coverCacheKey}
            alt={`${album.name} Cover`}
            loading="eager"
            decoding="async"
          />
        ) : (
          <div className="album-card-cover-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
        )}
        {(isNewAlbum || (isOffline && !selectionMode)) && (
          <div className="album-card-cover-badges-tr">
            {isNewAlbum && (
              <div className="album-card-new-badge" aria-label={t('common.new', 'New')}>
                {t('common.new', 'New')}
              </div>
            )}
            {isOffline && !selectionMode && (
              <div className="album-card-offline-badge" aria-label="Offline available">
                <HardDriveDownload size={12} />
              </div>
            )}
          </div>
        )}
        {selectionMode && (
          <div className={`album-card-select-check${selected ? ' album-card-select-check--on' : ''}`}>
            {selected && <Check size={14} strokeWidth={3} />}
          </div>
        )}
        {!selectionMode && (
          <div className="album-card-play-overlay">
            <button
              className="album-card-details-btn"
              onClick={e => { e.stopPropagation(); playAlbum(album.id); }}
              aria-label={`${album.name} abspielen`}
              data-tooltip={t('hero.playAlbum')}
              data-tooltip-pos="top"
            >
              <Play size={15} fill="currentColor" />
            </button>
            <button
              className="album-card-details-btn"
              onClick={async e => {
                e.stopPropagation();
                try {
                  const data = await getAlbum(album.id);
                  enqueue(data.songs.map(songToTrack));
                } catch {
                  // Network failure — silent (toast would be too noisy for a hover action)
                }
              }}
              aria-label={t('contextMenu.enqueueAlbum')}
              data-tooltip={t('contextMenu.enqueueAlbum')}
              data-tooltip-pos="top"
            >
              <ListPlus size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="album-card-info">
        <p className="album-card-title truncate">{album.name}</p>
        <p
          className={`album-card-artist truncate${album.artistId ? ' track-artist-link' : ''}`}
          style={{ cursor: album.artistId ? 'pointer' : 'default' }}
          onClick={e => { if (album.artistId) { e.stopPropagation(); navigate(`/artist/${album.artistId}`); } }}
        >{album.artist}</p>
        {album.year && <p className="album-card-year">{album.year}</p>}
        {showRating && (album.userRating ?? 0) > 0 && (
          <div className="album-card-rating-row">
            <span className="album-card-rating-stars">
              {'★'.repeat(album.userRating!)}{'☆'.repeat(5 - album.userRating!)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AlbumCard);
