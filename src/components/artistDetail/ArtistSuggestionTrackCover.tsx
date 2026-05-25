import React from 'react';
import { CoverArtImage } from '../../cover/CoverArtImage';
import { COVER_DENSE_ARTIST_LIST_CSS_PX } from '../../cover/layoutSizes';

export default function ArtistSuggestionTrackCover({ coverArt, album }: { coverArt: string; album: string }) {
  return (
    <CoverArtImage
      coverArtId={coverArt}
      displayCssPx={COVER_DENSE_ARTIST_LIST_CSS_PX}
      surface="dense"
      alt={album}
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
  );
}
