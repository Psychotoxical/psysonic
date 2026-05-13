import React, { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc3, ExternalLink, Music } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import CachedImage from '../CachedImage';

interface DiscographyCardProps {
  artistId?: string;
  albums: SubsonicAlbum[];
  currentAlbumId?: string;
  onNavigate: (path: string) => void;
}

const DISC_GRID_COLS = 10;
const DISC_INITIAL_ROWS = 2;
const DISC_INITIAL = DISC_GRID_COLS * DISC_INITIAL_ROWS;

const DiscographyCard = memo(function DiscographyCard({ artistId, albums, currentAlbumId, onNavigate }: DiscographyCardProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { setShowAll(false); }, [artistId]);

  if (albums.length === 0) return null;

  // Chronological sort, newest first. Always clamp to initial rows; expansion is explicit.
  const ordered = [...albums].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const visible = showAll ? ordered : ordered.slice(0, DISC_INITIAL);
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">
          <Disc3 size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
          {t('nowPlaying.discography', 'Discography')}
        </h3>
        {artistId && (
          <button className="np-card-link" onClick={() => onNavigate(`/artist/${artistId}`)}>
            {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-dash-disc-grid">
        {visible.map(a => {
          const isActive = a.id === currentAlbumId;
          const fetchUrl = a.coverArt ? buildCoverArtUrl(a.coverArt, 200) : '';
          const key      = a.coverArt ? coverArtCacheKey(a.coverArt, 200) : '';
          return (
            <div key={a.id}
              className={`np-dash-disc-tile${isActive ? ' active' : ''}`}
              onClick={() => onNavigate(`/album/${a.id}`)}
              data-tooltip={`${a.name}${a.year ? ` · ${a.year}` : ''}`}>
              <div className="np-dash-disc-cover">
                {fetchUrl && key
                  ? <CachedImage src={fetchUrl} cacheKey={key} alt={a.name} className="np-dash-disc-img" />
                  : <div className="np-dash-disc-fallback"><Music size={18} /></div>}
              </div>
            </div>
          );
        })}
      </div>
      {ordered.length > DISC_INITIAL && (
        <button className="np-dash-tracklist-more" onClick={() => setShowAll(v => !v)}>
          {showAll
            ? t('nowPlaying.showLessTracks', 'Show less')
            : t('nowPlaying.showMoreTracks', { defaultValue: 'Show {{count}} more', count: hiddenCount })}
        </button>
      )}
    </div>
  );
});

export default DiscographyCard;
