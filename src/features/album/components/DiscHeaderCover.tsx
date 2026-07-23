import { useMemo } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useTrackCoverRef } from '@/cover/useLibraryCoverRef';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { COVER_TRACK_ROW_CSS_PX } from '@/cover/layoutSizes';

export type DiscSeparatorSong = Pick<
  SubsonicSong,
  'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'
>;

/**
 * Cover shown next to a multi-disc separator ("CD N"), resolved from the disc's own
 * first track through the standard track-cover path (`useTrackCoverRef`).
 *
 * This is the same resolver the queue rows, now-playing hero and playbar use: it is
 * album-scoped by default and switches to a per-disc slot only when the library index
 * has recorded genuinely distinct disc covers for the album
 * (`resolveDistinctDiscCoversForAlbum`, seeded from the full tracklist on the album
 * page). So the separator's cover, disk cache slot and fetch id stay identical to every
 * other surface for the same disc — a box set shows each disc's own art, while a
 * single-cover album reuses the shared `al-<albumId>_0` slot the album hero already
 * warmed (no per-disc `mf-*` divergence, and nothing to fall back to offline).
 *
 * Rendered at `COVER_TRACK_ROW_CSS_PX` on the `dense` surface — the same display tier as
 * the track-row / queue thumbs — so it maps to the exact same on-disk cache entry.
 */
export function DiscHeaderCover({ song }: { song: DiscSeparatorSong }) {
  const scope = useMemo(() => coverServerScopeForServerId(song.serverId), [song.serverId]);
  const coverRef = useTrackCoverRef(song, scope);
  if (!coverRef) return null;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={COVER_TRACK_ROW_CSS_PX}
      surface="dense"
      alt=""
      loading="lazy"
      decoding="async"
      className="track-row-cover-thumb"
    />
  );
}
