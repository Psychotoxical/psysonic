import React from 'react';
import { CoverArtImage } from '../../cover/CoverArtImage';
import type { DiskCoverIdHints } from '../../cover/diskPeekIds';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '../../cover/layoutSizes';

export default function ArtistTopTrackCover({
  coverArt,
  album,
  diskIdHints,
}: {
  coverArt: string;
  album: string;
  diskIdHints?: DiskCoverIdHints;
}) {
  return (
    <CoverArtImage
      coverArtId={coverArt}
      displayCssPx={COVER_ARTIST_TOP_TRACK_CSS_PX}
      surface="sparse"
      ensurePriority="high"
      diskIdHints={diskIdHints}
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}
