import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { SubsonicArtistInfo } from '@/lib/api/subsonicTypes';
import { isRealArtistImage } from '@/cover/isRealArtistImage';
import { sanitizeHtml } from '@/features/nowPlaying/utils/nowPlayingHelpers';
import CachedImage from '@/ui/CachedImage';

export interface ArtistCardTab {
  id?: string;
  name: string;
  artistInfo: SubsonicArtistInfo | null;
}

interface ArtistCardProps {
  artistName: string;
  artistId?: string;
  artistInfo: SubsonicArtistInfo | null;
  /** When more than one entry, render picker tabs (Now Playing multi-artist tracks). */
  artistTabs?: ArtistCardTab[];
  /** When omitted the "Go to Artist" link and similar-artist chip click handlers do nothing — used on /artist/:id where the user is already there. */
  onNavigate?: (path: string) => void;
  /** Render fallback cover when artistInfo has no hero image (ArtistDetail's coverArt fallback). */
  coverFallback?: { src: string; cacheKey: string };
  /** Suppress the artist-name row — ArtistDetail shows the name in its hero already. */
  hideArtistName?: boolean;
  /** Suppress the similar-artists chip row — ArtistDetail has its own similar section. */
  hideSimilar?: boolean;
}

function heroForEntry(
  artistId: string | undefined,
  artistInfo: SubsonicArtistInfo | null,
  coverFallback?: { src: string; cacheKey: string },
): { heroImage: string; heroCacheKey: string } {
  const rawLarge = artistInfo?.largeImageUrl;
  const rawMed = artistInfo?.mediumImageUrl;
  const heroFromInfo = isRealArtistImage(rawLarge)
    ? rawLarge!
    : isRealArtistImage(rawMed) ? rawMed! : '';
  const heroImage = heroFromInfo || coverFallback?.src || '';
  const heroCacheKey = heroFromInfo
    ? (artistId ? `artistInfo:${artistId}:hero` : '')
    : (coverFallback?.cacheKey ?? '');
  return { heroImage, heroCacheKey };
}

function entryHasContent(
  entry: ArtistCardTab,
  hideSimilar: boolean,
  coverFallback?: { src: string; cacheKey: string },
): boolean {
  const bioHtml = entry.artistInfo?.biography ? sanitizeHtml(entry.artistInfo.biography) : '';
  const similar = hideSimilar ? [] : (entry.artistInfo?.similarArtist ?? []);
  const { heroImage } = heroForEntry(entry.id, entry.artistInfo, coverFallback);
  return Boolean(bioHtml || similar.length > 0 || heroImage);
}

const ArtistCard = memo(function ArtistCard({
  artistName, artistId, artistInfo, artistTabs, onNavigate, coverFallback,
  hideArtistName = false, hideSimilar = false,
}: ArtistCardProps) {
  const { t } = useTranslation();
  const [bioExpanded, setBioExpanded] = useState(false);
  const [bioOverflows, setBioOverflows] = useState(false);
  const bioRef = useRef<HTMLDivElement | null>(null);

  const tabs = artistTabs && artistTabs.length > 1 ? artistTabs : null;
  const tabsKey = tabs?.map(tab => tab.id ?? tab.name).join('\x1e') ?? '';
  const [activeTabIdx, setActiveTabIdx] = useState(0);

  useEffect(() => { setActiveTabIdx(0); }, [tabsKey]);
  useEffect(() => { setBioExpanded(false); }, [artistId, tabsKey, activeTabIdx]);

  const activeEntry = tabs
    ? tabs[Math.min(activeTabIdx, tabs.length - 1)]
    : { id: artistId, name: artistName, artistInfo };

  const activeArtistId = activeEntry.id;
  const activeArtistName = activeEntry.name;
  const activeArtistInfo = activeEntry.artistInfo;

  const bioHtml = useMemo(
    () => activeArtistInfo?.biography ? sanitizeHtml(activeArtistInfo.biography) : '',
    [activeArtistInfo?.biography],
  );

  useLayoutEffect(() => {
    const el = bioRef.current;
    if (!el) { setBioOverflows(false); return; }
    setBioOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [bioHtml]);

  const similar = hideSimilar ? [] : (activeArtistInfo?.similarArtist ?? []);
  const { heroImage, heroCacheKey } = heroForEntry(activeArtistId, activeArtistInfo, coverFallback);

  const visible = tabs
    ? tabs.some(tab => entryHasContent(tab, hideSimilar, coverFallback))
    : entryHasContent({ id: artistId, name: artistName, artistInfo }, hideSimilar, coverFallback);

  if (!visible) return null;

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlaying.aboutArtist')}</h3>
        {activeArtistId && onNavigate && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${activeArtistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>

      {tabs && (
        <div className="np-artist-tab-row" role="tablist" aria-label={t('nowPlaying.aboutArtist')}>
          {tabs.map((tab, idx) => (
            <button
              key={tab.id ?? tab.name}
              type="button"
              role="tab"
              aria-selected={idx === activeTabIdx}
              className={`np-artist-tab${idx === activeTabIdx ? ' is-active' : ''}`}
              onClick={() => setActiveTabIdx(idx)}
            >
              {tab.name}
            </button>
          ))}
        </div>
      )}

      <div className="np-dash-artist-body">
        {heroImage && heroCacheKey && (
          <CachedImage
            src={heroImage}
            cacheKey={heroCacheKey}
            alt={activeArtistName}
            className="np-dash-artist-image"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div className="np-dash-artist-text">
          {!hideArtistName && !tabs && <div className="np-dash-artist-name">{activeArtistName}</div>}
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
