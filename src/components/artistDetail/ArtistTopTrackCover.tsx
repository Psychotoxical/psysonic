import React from 'react';
import { CoverArtImage } from '../../cover/CoverArtImage';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '../../cover/layoutSizes';

export default function ArtistTopTrackCover({ coverArt, album }: { coverArt: string; album: string }) {
  return (
    <CoverArtImage
      coverArtId={coverArt}
      displayCssPx={COVER_ARTIST_TOP_TRACK_CSS_PX}
      surface="sparse"
      ensurePriority="high"
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}
