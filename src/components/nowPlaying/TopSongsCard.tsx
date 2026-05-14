import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Play, TrendingUp } from 'lucide-react';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { formatTime } from '../../utils/componentHelpers/nowPlayingHelpers';

interface TopSongsCardProps {
  artistName: string;
  artistId?: string;
  songs: SubsonicSong[];
  currentTrackId: string;
  onNavigate: (path: string) => void;
  onPlay: (song: SubsonicSong) => void;
}

const TopSongsCard = memo(function TopSongsCard({ artistName, artistId, songs, currentTrackId, onNavigate, onPlay }: TopSongsCardProps) {
  const { t } = useTranslation();
  const top = songs.slice(0, 8);
  if (top.length === 0) return null;

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <TrendingUp size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.topSongs', { defaultValue: 'Most played by this artist' })}
        </h3>
        {artistId && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-top-list">
        {top.map((s, idx) => {
          const isActive = s.id === currentTrackId;
          return (
            <div key={s.id}
              className={`np-dash-top-row${isActive ? ' active' : ''}`}
              onClick={() => onPlay(s)}
              data-tooltip={t('contextMenu.playNow')}>
              <span className="np-dash-top-rank">{idx + 1}</span>
              <div className="np-dash-top-body">
                <span className="np-dash-top-title truncate">{s.title}</span>
                {s.album && <span className="np-dash-top-sub truncate">{s.album}</span>}
              </div>
              <span className="np-dash-top-dur">{formatTime(s.duration)}</span>
              <Play size={14} className="np-dash-top-play" />
            </div>
          );
        })}
      </div>
      <div className="np-dash-top-credit">{t('nowPlaying.topSongsCredit', { name: artistName, defaultValue: 'Top tracks from {{name}}' })}</div>
    </div>
  );
});

export default TopSongsCard;
