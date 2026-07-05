import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';

/**
 * Shared media-domain model. `Track` is the app's normalized song shape (built
 * from a Subsonic child via `songToTrack`) and `QueueItemRef` its thin queue
 * identity; both are consumed app-wide (queue, playback, cover, context menus,
 * sharing, lucky-mix, library browse). They live in `lib/media` -- not inside
 * the playback feature -- so every layer can depend on the model without an
 * inverted edge into `@/features/playback`.
 */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  /** OpenSubsonic `artists` on the child song — multiple performers with ids. */
  artists?: SubsonicOpenArtistRef[];
  duration: number;
  coverArt?: string;
  discNumber?: number;
  track?: number;
  year?: number;
  bitRate?: number;
  suffix?: string;
  userRating?: number;
  replayGainTrackDb?: number;
  replayGainAlbumDb?: number;
  replayGainPeak?: number;
  starred?: string;
  genre?: string;
  samplingRate?: number;
  bitDepth?: number;
  /** Subsonic `size` in bytes when provided by the server (helps hot-cache budgeting). */
  size?: number;
  /** Owning server profile id when the queue spans multiple servers (e.g. offline favorites). */
  serverId?: string;
  autoAdded?: boolean;
  radioAdded?: boolean;
  /** Inserted via "Play Next". Used by the preserve-order toggle to find the
   *  end of the current Play-Next streak. Stale flags behind queueIndex are
   *  harmless — the streak scan only looks forward from queueIndex+1. */
  playNextAdded?: boolean;
}

/**
 * Thin canonical queue item (queue thin-state plan, §5.10). Identity plus the
 * queue-only flags; library metadata (title/artist/cover/…) is resolved from
 * the local index or network on demand from Phase 2 on. `serverId` is per-item
 * (day-1 schema for mixed-server queues); v1 fills it with the single playback
 * server.
 */
export interface QueueItemRef {
  serverId: string;
  trackId: string;
  autoAdded?: boolean;
  radioAdded?: boolean;
  playNextAdded?: boolean;
}
