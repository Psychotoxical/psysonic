import React, { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc3, ExternalLink, Star } from 'lucide-react';
import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';
import { formatTime, formatTotalDuration } from '../../utils/componentHelpers/nowPlayingHelpers';

interface AlbumCardProps {
  album: SubsonicAlbum | null;
  songs: SubsonicSong[];
  currentTrackId: string;
  albumName: string;
  albumId?: string;
  albumYear?: number;
  onNavigate: (path: string) => void;
}

const ALBUM_TRACK_LIMIT = 10;

const AlbumCard = memo(function AlbumCard({ album, songs, currentTrackId, albumName, albumId, albumYear, onNavigate }: AlbumCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [albumId]);

  if (songs.length === 0) return null;

  const totalDur = songs.reduce((sum, s) => sum + (s.duration || 0), 0);
  const currentIdx = songs.findIndex(s => s.id === currentTrackId);
  const position = currentIdx >= 0 ? `${currentIdx + 1} / ${songs.length}` : `${songs.length}`;

  // Sliding window anchored at the current track: when the running track sits
  // beyond position N, show the N tracks ending with (and including) it.
  // "Show all" expands to the full list.
  let visibleSongs: SubsonicSong[];
  if (showAll) {
    visibleSongs = songs;
  } else if (currentIdx < ALBUM_TRACK_LIMIT) {
    visibleSongs = songs.slice(0, ALBUM_TRACK_LIMIT);
  } else {
    const end = currentIdx + 1;
    visibleSongs = songs.slice(end - ALBUM_TRACK_LIMIT, end);
  }
  const hiddenCount = Math.max(0, songs.length - visibleSongs.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Disc3 size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.fromAlbum')}
        </h3>
        {albumId && (
          <button className="np-card-link" onClick={() => onNavigate(`/album/${albumId}`)}>
            {t('nowPlaying.viewAlbum')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-album-meta">
        <span className="np-dash-album-name">{albumName}</span>
        <span className="np-dash-album-stats">
          {albumYear && <span>{albumYear}</span>}
          {albumYear && <span className="np-sep">·</span>}
          <span>{t('nowPlaying.trackPosition', { pos: position, defaultValue: 'Track {{pos}}' })}</span>
          <span className="np-sep">·</span>
          <span>{formatTotalDuration(totalDur)}</span>
          {album?.playCount != null && album.playCount > 0 && (
            <><span className="np-sep">·</span><span>{t('nowPlaying.playsCount', { count: album.playCount, defaultValue: '{{count}} plays' })}</span></>
          )}
        </span>
      </div>
      <div className="np-album-tracklist">
        {visibleSongs.map(track => {
          const isActive = track.id === currentTrackId;
          return (
            <div key={track.id}
              className={`np-album-track${isActive ? ' active' : ''}`}>
              <span className="np-album-track-num">
                {isActive
                  ? <Star size={10} fill="var(--accent)" color="var(--accent)" />
                  : track.track ?? '—'}
              </span>
              <span className="np-album-track-title truncate">{track.title}</span>
              <span className="np-album-track-dur">{formatTime(track.duration)}</span>
            </div>
          );
        })}
      </div>
      {songs.length > ALBUM_TRACK_LIMIT && (
        <button className="np-dash-tracklist-more" onClick={() => setShowAll(v => !v)}>
          {showAll
            ? t('nowPlaying.showLessTracks', 'Show less')
            : t('nowPlaying.showMoreTracks', { defaultValue: 'Show {{count}} more', count: hiddenCount })}
        </button>
      )}
    </div>
  );
});

export default AlbumCard;
