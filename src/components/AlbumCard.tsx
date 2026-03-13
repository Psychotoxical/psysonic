import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { SubsonicAlbum, buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from './CachedImage';

interface AlbumCardProps {
  album: SubsonicAlbum;
}

export default function AlbumCard({ album }: AlbumCardProps) {
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const coverUrl = album.coverArt ? buildCoverArtUrl(album.coverArt, 300) : '';

  return (
    <div
      className="album-card card"
      onClick={() => navigate(`/album/${album.id}`)}
      role="button"
      tabIndex={0}
      aria-label={`${album.name} von ${album.artist}`}
      onKeyDown={e => e.key === 'Enter' && navigate(`/album/${album.id}`)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, album, 'album');
      }}
      draggable
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          type: 'album',
          id: album.id,
          name: album.name,
        }));
      }}
    >
      <div className="album-card-cover">
        {coverUrl ? (
          <CachedImage src={coverUrl} cacheKey={coverArtCacheKey(album.coverArt!, 300)} alt={`${album.name} Cover`} loading="lazy" />
        ) : (
          <div className="album-card-cover-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
        )}
        <div className="album-card-play-overlay">
          <button
            className="album-card-details-btn"
            onClick={e => { e.stopPropagation(); navigate(`/album/${album.id}`); }}
            aria-label={`Details zu ${album.name}`}
          >
            Details
          </button>
        </div>
      </div>
      <div className="album-card-info">
        <p className="album-card-title truncate" data-tooltip={album.name}>{album.name}</p>
        <p className="album-card-artist truncate" data-tooltip={album.artist}>{album.artist}</p>
        {album.year && <p className="album-card-year">{album.year}</p>}
      </div>
    </div>
  );
}
