import React from 'react';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useAlbumCoverRef } from '@/cover/useLibraryCoverRef';
import { COVER_ARTIST_TOP_TRACK_CSS_PX } from '@/cover/layoutSizes';
import type { TopSongAlbumCoverSource } from '@/features/artist/components/topSongAlbumForCover';

/** 32px album thumb — same cover ref path as {@link AlbumCard} on artist pages. */
export default function ArtistTopTrackCover({ album }: { album: TopSongAlbumCoverSource }) {
  const coverRef = useAlbumCoverRef(album.id, album.coverArt, undefined, { libraryResolve: false });
  if (!coverRef) return null;

  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={COVER_ARTIST_TOP_TRACK_CSS_PX}
      surface="dense"
      ensurePriority="high"
      alt={`${album.name} Cover`}
      loading="eager"
      decoding="async"
      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}
