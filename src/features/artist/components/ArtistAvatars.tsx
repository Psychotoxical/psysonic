import React from 'react';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import { ArtistCoverArtImage } from '@/cover/ArtistCoverArtImage';
import {
  COVER_DENSE_ARTIST_LIST_CSS_PX,
  COVER_DENSE_GRID_MIN_CELL_CSS_PX,
} from '@/cover/layoutSizes';
import { ARTISTS_INPAGE_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';
import { nameColor, nameInitial } from '@/features/artist/utils/artistsHelpers';

interface AvatarProps {
  artist: SubsonicArtist;
  showImages: boolean;
}

/**
 * Card-sized artist avatar for the grid view. Falls back to a coloured
 * monogram (Catppuccin palette, hashed by name) when artist images are
 * disabled or the artist has no cover art.
 */
export function ArtistCardAvatar({ artist, showImages }: AvatarProps) {
  const color = nameColor(artist.name);
  if (showImages && (artist.coverArt || artist.id)) {
    return (
      <div className="artist-card-avatar">
        <ArtistCoverArtImage
          artistId={artist.id}
          coverArt={artist.coverArt}
          displayCssPx={COVER_DENSE_GRID_MIN_CELL_CSS_PX}
          surface="dense"
          alt={artist.name}
          observeScrollRootId={ARTISTS_INPAGE_SCROLL_VIEWPORT_ID}
        />
      </div>
    );
  }
  return (
    <div className="artist-card-avatar artist-card-avatar-initial" style={{ borderColor: color }}>
      <span style={{ color }}>{nameInitial(artist.name)}</span>
    </div>
  );
}

/**
 * Row-sized artist avatar for the list view. Same fallback rules as the
 * card variant, but smaller layout px so list rows don't pull oversized images.
 */
export function ArtistRowAvatar({ artist, showImages }: AvatarProps) {
  const color = nameColor(artist.name);
  if (showImages && (artist.coverArt || artist.id)) {
    return (
      <div className="artist-avatar">
        <ArtistCoverArtImage
          artistId={artist.id}
          coverArt={artist.coverArt}
          displayCssPx={COVER_DENSE_ARTIST_LIST_CSS_PX}
          surface="dense"
          alt={artist.name}
          observeScrollRootId={ARTISTS_INPAGE_SCROLL_VIEWPORT_ID}
          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
        />
      </div>
    );
  }
  return (
    <div className="artist-avatar artist-avatar-initial" style={{ borderColor: color }}>
      <span style={{ color }}>{nameInitial(artist.name)}</span>
    </div>
  );
}
