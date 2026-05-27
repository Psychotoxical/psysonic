import React from 'react';
import { AlbumCoverArtImage } from '../../cover/AlbumCoverArtImage';
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
    <AlbumCoverArtImage
      albumId={albumId}
      coverArt={coverArt}
      displayCssPx={COVER_ARTIST_TOP_TRACK_CSS_PX}
      surface="sparse"
      ensurePriority="high"
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}
