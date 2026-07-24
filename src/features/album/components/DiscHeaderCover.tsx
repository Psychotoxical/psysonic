import { useMemo } from 'react';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useDiscCoverRef } from '@/cover/useLibraryCoverRef';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { COVER_TRACK_ROW_CSS_PX } from '@/cover/layoutSizes';

export type DiscSeparatorSong = Pick<
  SubsonicSong,
  'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'
>;

/**
 * Cover shown next to a multi-disc separator ("CD N"), resolved from the disc's own
 * first track via {@link useDiscCoverRef}.
 *
 * On Navidrome this maps to the server's canonical per-disc artwork id
 * (`dc-<albumId>:<discNumber>`), so each disc shows its own cover with one cache slot per
 * disc — correct even when the disc's tracks carry per-track `mf-*` ids that the
 * album-level distinct-disc heuristic can't recognise, and without needing a per-track
 * `coverArt`. On other servers it falls back to the standard track-cover path
 * (per-disc only when the disc's track has a usable disc-specific cover id, else the
 * shared `al-<albumId>_0` slot).
 *
 * Rendered at `COVER_TRACK_ROW_CSS_PX` on the `dense` surface — the same display tier as
 * the track-row / queue thumbs.
 */
export function DiscHeaderCover({ song }: { song: DiscSeparatorSong }) {
  const scope = useMemo(() => coverServerScopeForServerId(song.serverId), [song.serverId]);
  const coverRef = useDiscCoverRef(song, scope);
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
