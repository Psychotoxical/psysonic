import React from 'react';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';

/** 2×2 collage cell — half of clamp(120px, 15vw, 200px) playlist hero grid. */
const PLAYLIST_QUAD_CELL_CSS_PX = 100;
/** Full playlist hero / card cover square. */
const PLAYLIST_MAIN_COVER_CSS_PX = 200;

export function PlaylistSmartCoverCell({ coverId }: { coverId: string }) {
  return (
    <AlbumCoverArtImage
      albumId={coverId}
      coverArt={coverId}
      displayCssPx={PLAYLIST_QUAD_CELL_CSS_PX}
      surface="dense"
      className="playlist-cover-cell"
      alt=""
    />
  );
}

export function PlaylistCardMainCover({ coverArt, alt }: { coverArt: string; alt: string }) {
  return (
    <AlbumCoverArtImage
      albumId={coverArt}
      coverArt={coverArt}
      displayCssPx={PLAYLIST_MAIN_COVER_CSS_PX}
      surface="dense"
      alt={alt}
      className="album-card-cover-img"
    />
  );
}
