// Music Network — core domain types.
//
// These are the provider-agnostic shapes the rest of the app sees through the
// runtime facade. No provider names, no wire/transport details here. Wires map
// their own protocol responses onto these types; the application never touches a
// provider-specific shape.

/** Branded id for a registered wire implementation (transport + protocol). */
export type WireId = 'audioscrobbler_v2' | 'maloja_native' | 'listenbrainz';

/** Branded id for a built-in provider preset. */
export type PresetId =
  | 'lastfm'
  | 'librefm'
  | 'rocksky'
  | 'listenbrainz'
  | 'maloja_compat'
  | 'maloja_native'
  | 'maloja_listenbrainz'
  | 'koito'
  | 'custom_gnufm';

/**
 * Minimal identity of a track for enrichment lookups (love, stats, urls).
 * Audioscrobbler-class providers key on artist + title, not on a server id, so
 * this intentionally mirrors the `${title}::${artist}` cache key used today.
 */
export interface TrackRef {
  title: string;
  artist: string;
  /** Optional — used by wires that accept an album hint (e.g. MBID-less LB). */
  album?: string;
}

/** A playback event handed to scrobble destinations. */
export interface ScrobbleEvent {
  title: string;
  artist: string;
  album: string;
  /** Seconds. */
  duration: number;
  /** Epoch milliseconds the play started. Required for `scrobble`, ignored by now-playing. */
  timestamp: number;
}

/** Per-track stats (Now Playing cards). */
export interface TrackStats {
  listeners: number;
  playcount: number;
  userPlaycount: number | null;
  userLoved: boolean;
  tags: string[];
  url: string | null;
}

/** Per-artist stats incl. bio (Now Playing). */
export interface ArtistStats {
  listeners: number;
  playcount: number;
  userPlaycount: number | null;
  tags: string[];
  url: string | null;
  bio: string | null;
}

/** Connected-user profile (Integrations card). */
export interface UserProfile {
  username: string;
  playcount: number;
  /** Unix timestamp (seconds). 0 when unknown. */
  registeredAt: number;
}

/** Statistics-page period selector. */
export type StatsPeriod = 'overall' | '7day' | '1month' | '3month' | '6month' | '12month';

/** Which top-list to fetch. */
export type TopKind = 'artists' | 'albums' | 'tracks';

/** A single top-list row. `artist` is absent for `kind: 'artists'`. */
export interface TopItem {
  name: string;
  playcount: string;
  artist?: string;
}

/** A recent-scrobble row (Statistics page). */
export interface RecentTrack {
  name: string;
  artist: string;
  album: string;
  /** Unix timestamp (seconds), or null when currently playing. */
  timestamp: number | null;
  nowPlaying: boolean;
}
