import type { SubsonicArtist } from '../api/subsonicTypes';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CoverArtImage } from '../cover/CoverArtImage';
import { coverArtIdFromArtist } from '../cover/ids';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '../cover/layoutSizes';

interface Props {
  artist: SubsonicArtist;
  /** Appended to `/artist/:id`, e.g. `lossless=1`. */
  linkQuery?: string;
}

export default function ArtistCardLocal({ artist, linkQuery }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const coverId = coverArtIdFromArtist(artist);
  const href = linkQuery ? `/artist/${artist.id}?${linkQuery}` : `/artist/${artist.id}`;

  return (
    <div className="artist-card" onClick={() => navigate(href)}>
      <div className="artist-card-avatar">
        {artist.coverArt || artist.id ? (
          <CoverArtImage
            coverArtId={coverId}
            displayCssPx={COVER_DENSE_GRID_MIN_CELL_CSS_PX}
            surface="dense"
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
