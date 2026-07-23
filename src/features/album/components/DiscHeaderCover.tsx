import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { albumCoverRefForSong } from '@/cover/ref';
import { coverServerScopeForServerId } from '@/cover/serverScope';

type DiscHeaderSong = Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber' | 'serverId'>;

/**
 * Cover shown next to a multi-disc separator ("CD N"), resolved from the disc's
 * own first track rather than album-scoped.
 *
 * A disc's cover is that track's own art (`song.coverArt`). Servers surface
 * embedded per-file art as per-track `mf-*` ids, and the album-scoped heuristic
 * (`album_has_distinct_disc_covers`) deliberately rejects per-track ids to avoid a
 * per-song cache explosion — which routes every disc to the shared album slot, so
 * discs with genuinely different embedded art collide on the first disc's cover.
 * Forcing per-disc resolution here is safe: the separator renders at most one
 * cover per disc, so a dedicated per-track cache slot cannot explode. Genuine
 * per-disc `dc-*` art resolves the same way; single-cover albums simply reuse the
 * same bytes under a per-disc slot.
 */
export function DiscHeaderCover({ song }: { song: DiscHeaderSong }) {
  const coverRef = albumCoverRefForSong(song, true, coverServerScopeForServerId(song.serverId));
  if (!coverRef) return null;
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={40}
      surface="dense"
      alt=""
      loading="lazy"
      decoding="async"
      className="track-row-cover-thumb"
    />
  );
}
