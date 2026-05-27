import React from 'react';
import { CoverArtImage } from '../../cover/CoverArtImage';
import { albumCoverRef } from '../../cover/ref';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '../../cover/layoutSizes';

export default function ArtistTopTrackCover({
  albumId,
  coverArt,
  album,
}: {
  albumId: string;
  coverArt: string;
  album: string;
}) {
  return (
    <CoverArtImage
      coverRef={albumCoverRef(albumId, coverArt)}
      displayCssPx={COVER_ARTIST_TOP_TRACK_CSS_PX}
      surface="sparse"
      ensurePriority="high"
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}
