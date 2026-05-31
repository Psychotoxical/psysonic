import type { SubsonicArtist } from '../api/subsonicTypes';
import React from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CoverArtImage } from '../cover/CoverArtImage';
import { useArtistCoverRef } from '../cover/useLibraryCoverRef';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '../cover/layoutSizes';
import { useNavigateToArtist } from '../hooks/useNavigateToArtist';

interface Props {
  artist: SubsonicArtist;
  /** Appended to `/artist/:id`, e.g. `lossless=1`. */
  linkQuery?: string;
  /** Search/browse rows: API `coverArt` only — no per-card library_resolve IPC. */
  libraryResolve?: boolean;
}

export default function ArtistCardLocal({ artist, linkQuery, libraryResolve = false }: Props) {
  const { t } = useTranslation();
  const navigateToArtist = useNavigateToArtist();
  const coverRef = useArtistCoverRef(artist.id, artist.coverArt, undefined, { libraryResolve });

  return (
    <div
      className="artist-card"
      onClick={() => navigateToArtist(artist.id, linkQuery ? { search: linkQuery } : undefined)}
    >
      <div className="artist-card-avatar">
        {coverRef ? (
          <CoverArtImage
            coverRef={coverRef}
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
