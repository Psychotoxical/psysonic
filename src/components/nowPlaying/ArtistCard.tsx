import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { SubsonicArtistInfo } from '../../api/subsonicTypes';
import { isRealArtistImage, sanitizeHtml } from '../../utils/componentHelpers/nowPlayingHelpers';
import CachedImage from '../CachedImage';

interface ArtistCardProps {
  artistName: string;
  artistId?: string;
  artistInfo: SubsonicArtistInfo | null;
  /** When omitted the "Go to Artist" link and similar-artist chip click handlers do nothing — used on /artist/:id where the user is already there. */
  onNavigate?: (path: string) => void;
  /** Render fallback cover when artistInfo has no hero image (ArtistDetail's coverArt fallback). */
  coverFallback?: { src: string; cacheKey: string };
  /** Suppress the artist-name row — ArtistDetail shows the name in its hero already. */
  hideArtistName?: boolean;
  /** Suppress the similar-artists chip row — ArtistDetail has its own similar section. */
  hideSimilar?: boolean;
}

const ArtistCard = memo(function ArtistCard({
  artistName, artistId, artistInfo, onNavigate, coverFallback,
  hideArtistName = false, hideSimilar = false,
}: ArtistCardProps) {
  const { t } = useTranslation();
  const [bioExpanded, setBioExpanded] = useState(false);
  const [bioOverflows, setBioOverflows] = useState(false);
  const bioRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setBioExpanded(false); }, [artistId]);

  const bioHtml = useMemo(() => artistInfo?.biography ? sanitizeHtml(artistInfo.biography) : '', [artistInfo?.biography]);

  useLayoutEffect(() => {
    const el = bioRef.current;
    if (!el) { setBioOverflows(false); return; }
    setBioOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [bioHtml]);

  const similar = hideSimilar ? [] : (artistInfo?.similarArtist ?? []);
  const rawLarge = artistInfo?.largeImageUrl;
  const rawMed   = artistInfo?.mediumImageUrl;
  const heroFromInfo = isRealArtistImage(rawLarge)
    ? rawLarge!
    : isRealArtistImage(rawMed) ? rawMed! : '';
  const heroImage = heroFromInfo || coverFallback?.src || '';
  const heroCacheKey = heroFromInfo
    ? (artistId ? `artistInfo:${artistId}:hero` : '')
    : (coverFallback?.cacheKey ?? '');

  if (!bioHtml && similar.length === 0 && !heroImage) return null;

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlaying.aboutArtist')}</h3>
        {artistId && onNavigate && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>

      <div className="np-dash-artist-body">
        {heroImage && heroCacheKey && (
          <CachedImage
            src={heroImage}
            cacheKey={heroCacheKey}
            alt={artistName}
            className="np-dash-artist-image"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div className="np-dash-artist-text">
          {!hideArtistName && <div className="np-dash-artist-name">{artistName}</div>}
          {bioHtml && (
            <>
              <div
                ref={bioRef}
                className={`np-bio-text${bioExpanded ? ' expanded' : ''}`}
                dangerouslySetInnerHTML={{ __html: bioHtml }}
              />
              {(bioOverflows || bioExpanded) && (
                <button className="np-bio-toggle" onClick={() => setBioExpanded(v => !v)}>
                  {bioExpanded ? t('nowPlayingInfo.bioReadLess', 'Show less') : t('nowPlayingInfo.bioReadMore', 'Read more')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {similar.length > 0 && (
        <div className="np-dash-similar">
          <div className="np-dash-chip-row">
            {similar.slice(0, 12).map((a, idx) => (
              <span key={`${a.id}-${idx}`} className="np-chip"
                onClick={() => a.id && onNavigate?.(`/artist/${a.id}`)}
                data-tooltip={t('nowPlaying.goToArtist')}>
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default ArtistCard;
