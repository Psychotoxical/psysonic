import type { SubsonicServerIdentity } from '../utils/server/subsonicServerIdentity';

/** OpenSubsonic `ItemGenre` on songs/albums (atomic genres from the server). */
export interface SubsonicItemGenre {
  name: string;
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt?: string;
  songCount: number;
  duration: number;
  playCount?: number;
  year?: number;
  genre?: string;
  /** OpenSubsonic atomic genres — preferred over splitting `genre`. */
  genres?: SubsonicItemGenre[];
  starred?: string;
  recordLabel?: string;
  created?: string;
  /** Present on some servers (e.g. OpenSubsonic) for album-level rating. */
  userRating?: number;
  /** OpenSubsonic: true when the album is tagged as a compilation. */
  isCompilation?: boolean;
  /** OpenSubsonic: release types from MusicBrainz tags (e.g. "Album", "EP", "Single", "Compilation", "Live"). */
  releaseTypes?: string[];
  /** OpenSubsonic: structured album-artist credits (e.g. featured guests on the album). */
  artists?: SubsonicOpenArtistRef[];
  /** OpenSubsonic: single-string album-artist for display (mirrors `artists` joined). */
  displayArtist?: string;
  /** OpenSubsonic: per-disc subtitles (e.g. "Sessions" on CD 3 of a deluxe edition). */
  discTitles?: SubsonicDiscTitle[];
  /** Set when favorites are merged across servers (offline favorites tier). */
  serverId?: string;
}

export interface SubsonicDiscTitle {
  disc: number;
  title: string;
}

/** OpenSubsonic `artists` / `albumArtists` entries on a child song (may include `userRating`). */
export interface SubsonicOpenArtistRef {
  id?: string;
  name?: string;
  userRating?: number;
  /** Navidrome / alternate OpenSubsonic payloads (same meaning as `userRating`). */
  rating?: number;
}

export interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  duration: number;
  track?: number;
  discNumber?: number;
  coverArt?: string;
  year?: number;
  userRating?: number;
  /** Some OpenSubsonic responses attach parent ratings on child songs. */
  albumUserRating?: number;
  artistUserRating?: number;
  artists?: SubsonicOpenArtistRef[];
  albumArtists?: SubsonicOpenArtistRef[];
  // Audio technical info
  bitRate?: number;
  suffix?: string;
  contentType?: string;
  size?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
  starred?: string;
  genre?: string;
  /** OpenSubsonic atomic genres — preferred over splitting `genre`. */
  genres?: SubsonicItemGenre[];
  path?: string;
  albumArtist?: string;
  /** OpenSubsonic: single-string album-artist for display (mirrors `albumArtists` joined). */
  displayAlbumArtist?: string;
  /** ISRC code when available (e.g., Navidrome) */
  isrc?: string;
  /** Times the track has been played, surfaced by Navidrome's Subsonic API. */
  playCount?: number;
  /** ISO datetime of the last play, surfaced by Navidrome (OpenSubsonic). */
  played?: string;
  /** Beats per minute, surfaced by Navidrome when the tag is set on the file. */
  bpm?: number;
  /** Local index Advanced Search: `'tag'` (server/file tag) or `'analysis'` (measured). */
  localBpmSource?: 'tag' | 'analysis';
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
  /** Set when favorites are merged across servers (offline favorites tier). */
  serverId?: string;
  /** OpenSubsonic: structured composer credit (string for back-compat). */
  displayComposer?: string;
  /** OpenSubsonic: structured contributors list — Navidrome ≥ 0.55. */
  contributors?: Array<{
    role: string;
    subRole?: string;
    artist: { id?: string; name: string };
  }>;
}

export interface InternetRadioStation {
  id: string;
  name: string;
  streamUrl: string;
  homepageUrl?: string;
  coverArt?: string; // Navidrome v0.61.0+
}

export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  favicon: string;
  tags: string;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  owner?: string;
  public?: boolean;
  comment?: string;
  coverArt?: string;
}

/** OpenSubsonic `playbackReport` lifecycle state, per the extension spec. */
export type PlaybackReportState = 'starting' | 'playing' | 'paused' | 'stopped';

export interface SubsonicNowPlaying extends SubsonicSong {
  username: string;
  minutesAgo: number;
  playerId: number;
  playerName: string;
  /** OpenSubsonic `playbackReport`: live transport state for this stream. */
  state?: PlaybackReportState;
  /** OpenSubsonic `playbackReport`: server-extrapolated position in milliseconds. */
  positionMs?: number;
  /** OpenSubsonic `playbackReport`: effective playback speed (1.0 = normal). */
  playbackRate?: number;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  /** Article-stripped lowercase sort key (local index / OpenSubsonic). */
  nameSort?: string;
  albumCount?: number;
  coverArt?: string;
  starred?: string;
  /** Present on some servers (e.g. OpenSubsonic) for artist-level rating. */
  userRating?: number;
  /** Set when favorites are merged across servers (offline favorites tier). */
  serverId?: string;
}

export interface SubsonicGenre {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface SubsonicMusicFolder {
  id: string;
  name: string;
}

export interface SubsonicArtistInfo {
  biography?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtist?: Array<{ id: string; name: string; albumCount?: number }>;
}

export interface SubsonicDirectoryEntry {
  id: string;
  parent?: string;
  title: string;
  isDir: boolean;
  album?: string;
  artist?: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  duration?: number;
  track?: number;
  year?: number;
  bitRate?: number;
  suffix?: string;
  size?: number;
  genre?: string;
  starred?: string;
  userRating?: number;
}

export interface SubsonicDirectory {
  id: string;
  parent?: string;
  name: string;
  child: SubsonicDirectoryEntry[];
}

export type PingWithCredentialsResult = SubsonicServerIdentity & { ok: boolean };

export interface RandomSongsFilters {
  size?: number;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

export interface StatisticsLibraryAggregates {
  playtimeSec: number;
  albumsCounted: number;
  songsCounted: number;
  capped: boolean;
  genres: SubsonicGenre[];
}

export interface StatisticsOverviewData {
  recent: SubsonicAlbum[];
  frequent: SubsonicAlbum[];
  highest: SubsonicAlbum[];
  artistCount: number;
}

export interface StatisticsFormatSample {
  rows: { format: string; count: number }[];
  sampleSize: number;
}

export interface SearchResults {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export interface StarredResults {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export type EntityRatingSupportLevel = 'track_only' | 'full';

export interface AlbumInfo {
  largeImageUrl?: string;
  mediumImageUrl?: string;
  smallImageUrl?: string;
  notes?: string;
}

export const RADIO_PAGE_SIZE = 25;

export interface SubsonicLyricLine {
  start?: number; // milliseconds — absent when unsynced
  value: string;
}

export interface SubsonicStructuredLyrics {
  /** OpenSubsonic spec field name (Navidrome ≥ 0.50.0 / any OpenSubsonic server). */
  synced?: boolean;
  /** Legacy / alternate casing used by some older Subsonic-compatible servers. */
  issynced?: boolean;
  lang?: string;
  offset?: number;
  displayArtist?: string;
  displayTitle?: string;
  line: SubsonicLyricLine[];
}
