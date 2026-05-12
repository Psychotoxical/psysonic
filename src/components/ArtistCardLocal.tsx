import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import type { SubsonicArtist } from '../api/subsonicTypes';
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import CachedImage from './CachedImage';

interface Props {
  artist: SubsonicArtist;
}

export default function ArtistCardLocal({ artist }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const coverId = artist.coverArt || artist.id;
  // buildCoverArtUrl generates a new crypto salt on every call — must be
  // memoized to prevent a new URL on every parent re-render causing refetch loops.
  const coverSrc = useMemo(() => buildCoverArtUrl(coverId, 300), [coverId]);
  const coverCacheKey = useMemo(() => coverArtCacheKey(coverId, 300), [coverId]);

  return (
    <div className="artist-card" onClick={() => navigate(`/artist/${artist.id}`)}>
      <div className="artist-card-avatar">
        {coverId ? (
          <CachedImage
            src={coverSrc}
            cacheKey={coverCacheKey}
            alt={artist.name}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.parentElement?.classList.add('fallback-visible');
            }}
          />
        ) : (
          <Users size={32} color="var(--text-muted)" />
        )}
      </div>
      <div className="artist-card-info">
        <span className="artist-card-name">{artist.name}</span>
        {typeof artist.albumCount === 'number' && (
          <span className="artist-card-meta">
            {t('artists.albumCount', { count: artist.albumCount })}
          </span>
        )}
      </div>
    </div>
  );
}
