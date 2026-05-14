import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Headphones, Heart, MicVocal, Music, Star } from 'lucide-react';
import type { LastfmArtistStats, LastfmTrackInfo } from '../../api/lastfm';
import LastfmIcon from '../LastfmIcon';
import { formatTrackTime } from '../../utils/format/formatDuration';

interface HeroProps {
  track: { title: string; artist: string; album: string; year?: number;
    duration: number; suffix?: string; bitRate?: number; samplingRate?: number;
    bitDepth?: number; artistId?: string; albumId?: string; id: string;
    userRating?: number; };
  genre?: string;
  playCount?: number;
  userRatingOverride?: number;
  lfmTrack: LastfmTrackInfo | null;
  lfmArtist: LastfmArtistStats | null;
  starred: boolean;
  lfmLoved: boolean;
  lfmLoveEnabled: boolean;
  activeLyricsTab: boolean;
  coverUrl: string;
  onNavigate: (path: string) => void;
  onToggleStar: () => void;
  onToggleLfmLove: () => void;
  onOpenLyrics: () => void;
}

function renderStars(rating?: number) {
  if (!rating) return null;
  return (
    <div className="np-stars-inline">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={13}
          fill={i <= rating ? 'var(--ctp-yellow)' : 'none'}
          color={i <= rating ? 'var(--ctp-yellow)' : 'var(--ctp-overlay1)'}
        />
      ))}
    </div>
  );
}

const Hero = memo(function Hero({ track, genre, playCount, userRatingOverride, lfmTrack, lfmArtist, starred, lfmLoved, lfmLoveEnabled, activeLyricsTab, coverUrl, onNavigate, onToggleStar, onToggleLfmLove, onOpenLyrics }: HeroProps) {
  const { t } = useTranslation();
  const rating = userRatingOverride ?? track.userRating;
  const hiRes  = (track.bitDepth && track.bitDepth > 16) || (track.samplingRate && track.samplingRate > 48000);
  const releaseAge = track.year ? new Date().getFullYear() - track.year : 0;

  return (
    <div className="np-dash-hero">
      <div className="np-dash-hero-cover">
        {coverUrl
          ? <img src={coverUrl} alt="" className="np-cover" />
          : <div className="np-cover np-cover-fallback"><Music size={64} /></div>}
      </div>
      <div className="np-dash-hero-body">
        <div className="np-dash-hero-title">{track.title}</div>
        <div className="np-dash-hero-sub">
          <span className="np-link"
            onClick={() => track.artistId && onNavigate(`/artist/${track.artistId}`)}
            style={{ cursor: track.artistId ? 'pointer' : 'default' }}>
            {track.artist}
          </span>
          <span className="np-sep">·</span>
          <span className="np-link"
            onClick={() => track.albumId && onNavigate(`/album/${track.albumId}`)}
            style={{ cursor: track.albumId ? 'pointer' : 'default' }}>
            {track.album}
          </span>
          {track.year && <><span className="np-sep">·</span><span>{track.year}</span></>}
          {releaseAge > 0 && (
            <><span className="np-sep">·</span>
            <span className="np-dash-hero-age">
              {t('nowPlaying.releasedYearsAgo', { count: releaseAge, defaultValue: '{{count}} years ago' })}
            </span></>
          )}
        </div>

        <div className="np-dash-hero-badges">
          {genre && <span className="np-badge">{genre}</span>}
          {track.suffix && <span className="np-badge">{track.suffix.toUpperCase()}</span>}
          {track.bitRate && <span className="np-badge">{track.bitRate} kbps</span>}
          {track.samplingRate && <span className="np-badge">{(track.samplingRate / 1000).toFixed(1)} kHz</span>}
          {track.bitDepth && <span className="np-badge">{track.bitDepth}-bit</span>}
          {hiRes && <span className="np-badge np-badge-hires">Hi-Res</span>}
          {track.duration > 0 && <span className="np-badge">{formatTrackTime(track.duration)}</span>}
        </div>

        <div className="np-dash-hero-actions">
          <button onClick={onToggleStar} className="np-dash-icon-btn"
            data-tooltip={starred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}>
            <Heart size={18} fill={starred ? 'var(--ctp-yellow)' : 'none'} color={starred ? 'var(--ctp-yellow)' : 'currentColor'} />
          </button>
          {lfmLoveEnabled && (
            <button onClick={onToggleLfmLove}
              className={`np-dash-icon-btn np-dash-lfm-btn${lfmLoved ? ' is-loved' : ''}`}
              data-tooltip={lfmLoved ? t('contextMenu.lfmUnlove') : t('contextMenu.lfmLove')}>
              <LastfmIcon size={18} />
            </button>
          )}
          <button className="np-dash-icon-btn"
            onClick={onOpenLyrics}
            data-tooltip={t('player.lyrics')}
            style={{ color: activeLyricsTab ? 'var(--accent)' : undefined }}>
            <MicVocal size={18} />
          </button>
          {rating && renderStars(rating)}
        </div>

        {(playCount != null && playCount > 0) && (
          <div className="np-dash-hero-stat">
            <Headphones size={13} />
            <span>{t('nowPlaying.playsCount', { count: playCount, defaultValue: '{{count}} plays' })}</span>
          </div>
        )}

        {(lfmTrack || lfmArtist) && (
          <div className="np-dash-hero-lfm">
            <div className="np-dash-hero-lfm-heading">
              <span className="np-dash-hero-lfm-badge">Last.fm</span>
            </div>
            {lfmTrack && (
              <div className="np-dash-hero-lfm-row">
                <span className="np-dash-hero-lfm-scope">{t('nowPlaying.thisTrack', 'This track')}</span>
                <span className="np-dash-hero-lfm-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: lfmTrack.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-lfm-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: lfmTrack.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {lfmTrack.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-lfm-dot">·</span>
                    <span className="np-dash-hero-lfm-you">
                      {t('nowPlaying.playsByYouN', { n: lfmTrack.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
                    </span>
                  </>
                )}
              </div>
            )}
            {lfmArtist && (
              <div className="np-dash-hero-lfm-row">
                <span className="np-dash-hero-lfm-scope">{t('nowPlaying.thisArtist', 'This artist')}</span>
                <span className="np-dash-hero-lfm-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: lfmArtist.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-lfm-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: lfmArtist.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {lfmArtist.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-lfm-dot">·</span>
                    <span className="np-dash-hero-lfm-you">
                      {t('nowPlaying.playsByYouN', { n: lfmArtist.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default Hero;
