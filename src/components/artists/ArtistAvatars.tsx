import React, { useMemo } from 'react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import CachedImage from '../CachedImage';
import { nameColor, nameInitial } from '../../utils/componentHelpers/artistsHelpers';

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
  const coverId = artist.coverArt || artist.id;
  const { coverSrc, coverKey } = useMemo(
    () => ({
      coverSrc: coverId ? buildCoverArtUrl(coverId, 300) : '',
      coverKey: coverId ? coverArtCacheKey(coverId, 300) : '',
    }),
    [coverId],
  );
  if (showImages && coverId) {
    return (
      <div className="artist-card-avatar">
        <CachedImage
          src={coverSrc}
          cacheKey={coverKey}
          alt={artist.name}
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
 * card variant, but smaller cover-art size (64px vs 300px) so list rows
 * don't pull oversized images from the server.
 */
export function ArtistRowAvatar({ artist, showImages }: AvatarProps) {
  const color = nameColor(artist.name);
  const coverId = artist.coverArt || artist.id;
  const { coverSrc, coverKey } = useMemo(
    () => ({
      coverSrc: coverId ? buildCoverArtUrl(coverId, 64) : '',
      coverKey: coverId ? coverArtCacheKey(coverId, 64) : '',
    }),
    [coverId],
  );
  if (showImages && coverId) {
    return (
      <div className="artist-avatar">
        <CachedImage
          src={coverSrc}
          cacheKey={coverKey}
          alt={artist.name}
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
