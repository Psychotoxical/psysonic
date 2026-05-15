import type { SubsonicServerIdentity } from '../utils/server/subsonicServerIdentity';

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
  starred?: string;
  recordLabel?: string;
  created?: string;
  /** Present on some servers (e.g. OpenSubsonic) for album-level rating. */
  userRating?: number;
  /** OpenSubsonic: true when the album is tagged as a compilation. */
  isCompilation?: boolean;
  /** OpenSubsonic: release types from MusicBrainz tags (e.g. "Album", "EP", "Single", "Compilation", "Live"). */
  releaseTypes?: string[];
  /** OpenSubsonic: album-level credits (Navidrome may attach on album and/or child songs). */
  albumArtists?: SubsonicOpenArtistRef[];
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
  path?: string;
  albumArtist?: string;
  /** ISRC code when available (e.g., Navidrome) */
  isrc?: string;
  /** Times the track has been played, surfaced by Navidrome's Subsonic API. */
  playCount?: number;
  /** ISO datetime of the last play, surfaced by Navidrome (OpenSubsonic). */
  played?: string;
  /** Beats per minute, surfaced by Navidrome when the tag is set on the file. */
  bpm?: number;
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
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

export interface SubsonicNowPlaying extends SubsonicSong {
  username: string;
  minutesAgo: number;
  playerId: number;
  playerName: string;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  starred?: string;
  /** Present on some servers (e.g. OpenSubsonic) for artist-level rating. */
  userRating?: number;
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
