import React, { useState, useEffect } from 'react';
import { Music, Users } from 'lucide-react';
import type { SubsonicSong, SubsonicArtist } from '@/lib/api/subsonicTypes';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';
import { ArtistCoverArtImage } from '@/cover/ArtistCoverArtImage';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { COVER_DENSE_SEARCH_CSS_PX } from '@/cover/layoutSizes';
import { albumCoverRef } from '@/cover/ref';
import { FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM } from '@/ui/CachedImage';

export function LiveSearchAlbumThumb({ albumId, coverArt }: { albumId: string; coverArt: string }) {
  return (
    <AlbumCoverArtImage
      albumId={albumId}
      coverArt={coverArt}
      libraryResolve={false}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      ensurePriority="high"
    />
  );
}

export function LiveSearchSongThumb({ song }: { song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'> }) {
  // Search results carry the per-track `mf-…` coverArt id, which the cover
  // pipeline fails to resolve and the thumbnail goes blank. The album-scoped
  // `al-<albumId>_0` id is what actually loads (verified in the RC1 blank-thumb
  // investigation), and a song's search thumbnail is its album cover anyway —
  // so fetch the album cover from the albumId. Falls back to a music glyph when
  // there is no album to key on.
  const albumId = song.albumId?.trim();
  const coverRef = React.useMemo(
    () => (albumId ? albumCoverRef(albumId, `al-${albumId}_0`) : undefined),
    [albumId],
  );
  if (!coverRef) return <div className="search-result-icon"><Music size={14} /></div>;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      ensurePriority="high"
    />
  );
}

export function LiveSearchArtistThumb({ artist }: { artist: Pick<SubsonicArtist, 'id' | 'coverArt'> }) {
  const [failed, setFailed] = useState(false);
  // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setFailed(false); }, [artist.id, artist.coverArt]);
  if (failed) return <div className="search-result-icon"><Users size={14} /></div>;
  return (
    <ArtistCoverArtImage
      artistId={artist.id}
      coverArt={artist.coverArt}
      libraryResolve={false}
      displayCssPx={COVER_DENSE_SEARCH_CSS_PX}
      surface="dense"
      className="search-result-thumb"
      alt=""
      loading="eager"
      ensurePriority="high"
      fetchQueueBias={FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM}
      onError={() => setFailed(true)}
    />
  );
}
