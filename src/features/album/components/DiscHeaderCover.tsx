import { CoverArtImage } from '@/cover/CoverArtImage';
import {
  useDiscSeparatorCoverRef,
  type DiscSeparatorSong,
} from '@/features/album/hooks/useDiscSeparatorCoverRef';

const DISC_COVER_PX = 40;

/**
 * Cover shown next to a multi-disc separator ("CD N"), resolved from the disc's own
 * first track rather than album-scoped.
 *
 * A disc's cover is that track's own art (`song.coverArt`). Servers surface embedded
 * per-file art as per-track `mf-*` ids, and the album-scoped heuristic
 * (`album_has_distinct_disc_covers`) deliberately rejects per-track ids to avoid a
 * per-song cache explosion — which routes every disc to the shared album slot, so
 * discs with genuinely different embedded art collide on the first disc's cover.
 * `useDiscSeparatorCoverRef` forces per-disc resolution only when the track carries a
 * usable disc-specific cover id (the album-fallback shapes stay album-scoped so they
 * become Navidrome's `al-<albumId>_0` fetch id), and falls back to the shared album
 * cover when the disc-specific slot is unavailable offline.
 */
export function DiscHeaderCover({ song }: { song: DiscSeparatorSong }) {
  const coverRef = useDiscSeparatorCoverRef(song);
  if (!coverRef) return null;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={DISC_COVER_PX}
      surface="dense"
      alt=""
      loading="lazy"
      decoding="async"
      className="track-row-cover-thumb"
    />
  );
}
