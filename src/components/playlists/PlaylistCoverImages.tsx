import React, { useMemo } from 'react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import CachedImage from '../CachedImage';

export function PlaylistSmartCoverCell({ coverId }: { coverId: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverId, 200), [coverId]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverId, 200), [coverId]);
  return (
    <CachedImage
      className="playlist-cover-cell"
      src={src}
      cacheKey={cacheKey}
      alt=""
    />
  );
}

export function PlaylistCardMainCover({ coverArt, alt }: { coverArt: string; alt: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 256), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 256), [coverArt]);
  return (
    <CachedImage
      src={src}
      cacheKey={cacheKey}
      alt={alt}
      className="album-card-cover-img"
    />
  );
}
