import React, { useMemo } from 'react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import CachedImage from '../CachedImage';

export default function ArtistSuggestionTrackCover({ coverArt, album }: { coverArt: string; album: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 64), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 64), [coverArt]);
  return (
    <CachedImage
      src={src}
      cacheKey={cacheKey}
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}
