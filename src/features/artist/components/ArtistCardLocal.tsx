import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useThemeStore } from '@/store/themeStore';
import { useOverflowTooltip } from '@/lib/hooks/useOverflowTooltip';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useArtistCoverRef } from '@/cover/useLibraryCoverRef';
import { COVER_DENSE_GRID_MIN_CELL_CSS_PX } from '@/cover/layoutSizes';
import { useNavigateToArtist } from '@/features/artist/hooks/useNavigateToArtist';
import { coverServerScopeForServerId } from '@/cover/serverScope';

interface Props {
  artist: SubsonicArtist;
  /** Appended to `/artist/:id`, e.g. `lossless=1`. */
  linkQuery?: string;
  /** Search/browse rows: API `coverArt` only — no per-card library_resolve IPC. */
  libraryResolve?: boolean;
}

export default function ArtistCardLocal({ artist, linkQuery, libraryResolve = false }: Props) {
  const { t } = useTranslation();
  const showCardTooltips = useThemeStore(s => s.showCardTooltips);
  const nameTooltip = useOverflowTooltip(artist.name, showCardTooltips);
  const navigateToArtist = useNavigateToArtist();
  const coverServerScope = useMemo(
    () => coverServerScopeForServerId(artist.serverId),
    [artist.serverId],
  );
  const coverRef = useArtistCoverRef(artist.id, artist.coverArt, coverServerScope, { libraryResolve });
  return (
    <div
      className="artist-card"
      onClick={() => navigateToArtist(artist.id, {
        serverId: artist.serverId,
        search: linkQuery,
      })}
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
        <span className="artist-card-name" {...nameTooltip}>{artist.name}</span>
        {typeof artist.albumCount === 'number' && (
          <span className="artist-card-meta">
            {t('artists.albumCount', { count: artist.albumCount })}
          </span>
        )}
      </div>
    </div>
  );
}
