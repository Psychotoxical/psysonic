import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Headphones, Heart, MicVocal, Music, Star } from 'lucide-react';
import { CoverArtImage } from '@/cover/CoverArtImage';
import type { CoverArtRef } from '@/cover/types';
import type { ArtistStats, TrackStats } from '@/music-network';
import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import { OpenArtistRefInline } from '@/ui/OpenArtistRefInline';
import { formatTrackTime } from '@/lib/format/formatDuration';
import { renderPresetIcon, useEnrichmentPrimaryIcon, useEnrichmentPrimaryLabel } from '@/music-network';

interface HeroProps {
  track: { title: string; artist: string; album: string; year?: number;
    duration: number; suffix?: string; bitRate?: number; samplingRate?: number;
    bitDepth?: number; artistId?: string; albumId?: string; id: string;
    userRating?: number; };
  /** OpenSubsonic `artists` on the playing track — per-artist links in the hero subline. */
  artistRefs?: SubsonicOpenArtistRef[];
  genre?: string;
  playCount?: number;
  userRatingOverride?: number;
  networkTrack: TrackStats | null;
  networkArtist: ArtistStats | null;
  starred: boolean;
  networkLoved: boolean;
  networkLoveEnabled: boolean;
  activeLyricsTab: boolean;
  coverRef?: CoverArtRef;
  directCoverArtUrl?: string;
  onNavigate: (path: string) => void;
  onToggleStar: () => void;
  onToggleNetworkLove: () => void;
  onOpenLyrics: () => void;
}

function renderStars(rating?: number) {
  if (!rating) return null;
  return (
    <div className="np-stars-inline">
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={13}
          fill={i <= rating ? 'var(--highlight)' : 'none'}
          color={i <= rating ? 'var(--highlight)' : 'var(--border-subtle)'}
        />
      ))}
    </div>
  );
}

const Hero = memo(function Hero({ track, artistRefs, genre, playCount, userRatingOverride, networkTrack, networkArtist, starred, networkLoved, networkLoveEnabled, activeLyricsTab, coverRef, directCoverArtUrl, onNavigate, onToggleStar, onToggleNetworkLove, onOpenLyrics }: HeroProps) {
  const { t } = useTranslation();
  const networkLabel = useEnrichmentPrimaryLabel() ?? '';
  const networkIcon = useEnrichmentPrimaryIcon();
  const rating = userRatingOverride ?? track.userRating;
  const hiRes  = (track.bitDepth ?? 0) > 16 || (track.samplingRate ?? 0) > 48000;
  const releaseAge = track.year ? new Date().getFullYear() - track.year : 0;

  return (
    <div className="np-dash-hero">
      <div className="np-dash-hero-cover">
        {directCoverArtUrl ? (
          <img className="np-cover" src={directCoverArtUrl} alt="" />
        ) : coverRef ? (
          <CoverArtImage
            className="np-cover"
            coverRef={coverRef}
            displayCssPx={280}
            surface="sparse"
            ensurePriority="high"
            alt=""
          />
        ) : (
          <div className="np-cover np-cover-fallback"><Music size={64} /></div>
        )}
      </div>
      <div className="np-dash-hero-body">
        <div className="np-dash-hero-title">{track.title}</div>
        <div className="np-dash-hero-sub">
          {artistRefs && artistRefs.length > 0 ? (
            <OpenArtistRefInline
              refs={artistRefs}
              fallbackName={track.artist}
              onGoArtist={id => onNavigate(`/artist/${id}`)}
              as="none"
              linkTag="span"
              linkClassName="np-link"
            />
          ) : (
            <span className="np-link"
              onClick={() => track.artistId && onNavigate(`/artist/${track.artistId}`)}
              style={{ cursor: track.artistId ? 'pointer' : 'default' }}>
              {track.artist}
            </span>
          )}
          <span className="np-sep">·</span>
          <span className="np-link"
            onClick={() => track.albumId && onNavigate(`/album/${track.albumId}`)}
            style={{ cursor: track.albumId ? 'pointer' : 'default' }}>
            {track.album}
          </span>
          {track.year != null && track.year > 0 && <><span className="np-sep">·</span><span>{track.year}</span></>}
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
          {(track.bitRate ?? 0) > 0 && <span className="np-badge">{track.bitRate} kbps</span>}
          {(track.samplingRate ?? 0) > 0 && <span className="np-badge">{((track.samplingRate ?? 0) / 1000).toFixed(1)} kHz</span>}
          {(track.bitDepth ?? 0) > 0 && <span className="np-badge">{track.bitDepth}-bit</span>}
          {hiRes && <span className="np-badge np-badge-hires">Hi-Res</span>}
          {track.duration > 0 && <span className="np-badge">{formatTrackTime(track.duration)}</span>}
        </div>

        <div className="np-dash-hero-actions">
          <button onClick={onToggleStar} className="np-dash-icon-btn"
            data-tooltip={starred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}>
            <Heart size={18} fill={starred ? 'var(--highlight)' : 'none'} color={starred ? 'var(--highlight)' : 'currentColor'} />
          </button>
          {networkLoveEnabled && (
            <button onClick={onToggleNetworkLove}
              className={`np-dash-icon-btn np-dash-network-btn${networkLoved ? ' is-loved' : ''}`}
              data-tooltip={networkLoved ? t('contextMenu.networkUnlove', { provider: networkLabel }) : t('contextMenu.networkLove', { provider: networkLabel })}>
              {renderPresetIcon(networkIcon ?? 'lastfm', 18)}
            </button>
          )}
          <button className="np-dash-icon-btn"
            onClick={onOpenLyrics}
            data-tooltip={t('player.lyrics')}
            style={{ color: activeLyricsTab ? 'var(--accent)' : undefined }}>
            <MicVocal size={18} />
          </button>
          {rating != null && rating > 0 && renderStars(rating)}
        </div>

        {(playCount != null && playCount > 0) && (
          <div className="np-dash-hero-stat">
            <Headphones size={13} />
            <span>{t('nowPlaying.playsCount', { count: playCount, defaultValue: '{{count}} plays' })}</span>
          </div>
        )}

        {(networkTrack || networkArtist) && (
          <div className="np-dash-hero-network">
            <div className="np-dash-hero-network-heading">
              <span className="np-dash-hero-network-badge">{networkLabel}</span>
            </div>
            {networkTrack && (
              <div className="np-dash-hero-network-row">
                <span className="np-dash-hero-network-scope">{t('nowPlaying.thisTrack', 'This track')}</span>
                <span className="np-dash-hero-network-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: networkTrack.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-network-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: networkTrack.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {networkTrack.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-network-dot">·</span>
                    <span className="np-dash-hero-network-you">
                      {t('nowPlaying.playsByYouN', { n: networkTrack.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
                    </span>
                  </>
                )}
              </div>
            )}
            {networkArtist && (
              <div className="np-dash-hero-network-row">
                <span className="np-dash-hero-network-scope">{t('nowPlaying.thisArtist', 'This artist')}</span>
                <span className="np-dash-hero-network-sep">—</span>
                <span>{t('nowPlaying.listenersN', { n: networkArtist.listeners.toLocaleString(), defaultValue: '{{n}} listeners' })}</span>
                <span className="np-dash-hero-network-dot">·</span>
                <span>{t('nowPlaying.scrobblesN', { n: networkArtist.playcount.toLocaleString(), defaultValue: '{{n}} scrobbles' })}</span>
                {networkArtist.userPlaycount != null && (
                  <>
                    <span className="np-dash-hero-network-dot">·</span>
                    <span className="np-dash-hero-network-you">
                      {t('nowPlaying.playsByYouN', { n: networkArtist.userPlaycount.toLocaleString(), defaultValue: 'played {{n}}× by you' })}
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