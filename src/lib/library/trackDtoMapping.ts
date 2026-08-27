import type { LibraryTrackDto } from '@/lib/api/library';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Cover art id for a library track — mirrors Rust cover backfill
 * (`COALESCE(cover_art_id, album_id)`). Many servers only expose album art.
 */
export function resolveTrackCoverArtId(
  hot: Pick<LibraryTrackDto, 'coverArtId' | 'albumId'>,
  song: Partial<SubsonicSong> = {},
): string | undefined {
  const songArt = typeof song.coverArt === 'string' ? song.coverArt.trim() : '';
  const hotArt = typeof hot.coverArtId === 'string' ? hot.coverArtId.trim() : '';
  // `raw_json` per-disc `coverArt` wins over a stale index `cover_art_id` (often disc 1).
  if (songArt && hotArt && songArt !== hotArt && songArt.startsWith('mf-')) {
    return songArt;
  }
  for (const c of [hot.coverArtId, song.coverArt, hot.albumId, song.albumId]) {
    const id = typeof c === 'string' ? c.trim() : '';
    if (id) return id;
  }
  return undefined;
}

export function trackToSong(t: LibraryTrackDto): SubsonicSong {
  const raw = isObject(t.rawJson) ? t.rawJson : {};
  const resolvedBpm = t.bpm != null && t.bpm > 0 ? t.bpm : undefined;
  const base: SubsonicSong = {
    id: t.id,
    title: t.title,
    artist: t.artist ?? '',
    album: t.album,
    albumId: t.albumId ?? '',
    artistId: t.artistId ?? undefined,
    duration: t.durationSec,
    track: t.trackNumber ?? undefined,
    discNumber: t.discNumber ?? undefined,
    coverArt: resolveTrackCoverArtId(t),
    year: t.year ?? undefined,
    genre: t.genre ?? undefined,
    suffix: t.suffix ?? undefined,
    bitRate: t.bitRate ?? undefined,
    size: t.sizeBytes ?? undefined,
    starred: t.starredAt != null ? new Date(t.starredAt).toISOString() : undefined,
    userRating: t.userRating ?? undefined,
    playCount: t.playCount ?? undefined,
    bpm: resolvedBpm,
    isrc: t.isrc ?? undefined,
    albumArtist: t.albumArtist ?? undefined,
  };
  // `rawJson` is the authoritative original song — let it override the
  // hot-column fallbacks (it carries OpenSubsonic extras too).
  const merged: SubsonicSong = { ...base, ...(raw as Partial<SubsonicSong>) };
  const coverArt = resolveTrackCoverArtId(t, merged);
  if (coverArt) merged.coverArt = coverArt;
  if (resolvedBpm != null) merged.bpm = resolvedBpm;
  if (t.bpmSource === 'analysis' || t.bpmSource === 'tag') {
    merged.localBpmSource = t.bpmSource;
  }
  if (t.replayGainTrackDb != null || t.replayGainAlbumDb != null || t.replayGainPeak != null) {
    merged.replayGain = {
      ...merged.replayGain,
      trackGain: t.replayGainTrackDb ?? merged.replayGain?.trackGain,
      albumGain: t.replayGainAlbumDb ?? merged.replayGain?.albumGain,
      trackPeak: t.replayGainPeak ?? merged.replayGain?.trackPeak,
    };
  }
  // Play statistics are the one pair the frozen `rawJson` snapshot must not
  // win. Patch-on-use writes these columns after every play, while the snapshot
  // only changes when the row is synced again — so the column is never older.
  // Letting the snapshot through meant the app showed nothing while holding the
  // very timestamp the server was showing.
  // Both columns carry a server-authoritative number: the sync writes what the
  // server reported, and a finished play refreshes them from the server rather
  // than counting locally (`scrobbleSong`). There is therefore no local tally
  // that could stand next to a server total in a unit of its own.
  if (t.playCount != null) merged.playCount = t.playCount;
  if (t.playedAt != null) {
    merged.played = new Date(t.playedAt).toISOString();
  } else if (merged.played == null) {
    // Navidrome's native API calls this `playDate`, and rows ingested before the
    // mapper learned that name kept the date only inside `rawJson`, with
    // `played_at` left NULL. Nothing revisits them on its own: a play does not
    // move `updatedAt`, so the delta sync never offers the row again. Reading
    // the snapshot here is what makes those rows show a date at all.
    const playDate = (raw as { playDate?: unknown }).playDate;
    const parsed = typeof playDate === 'string' ? Date.parse(playDate) : NaN;
    if (Number.isFinite(parsed)) merged.played = new Date(parsed).toISOString();
  }
  if (t.serverId) merged.serverId = t.serverId;
  const hotAlbumId = base.albumId?.trim();
  if (hotAlbumId && !merged.albumId?.trim()) {
    merged.albumId = hotAlbumId;
  }
  return merged;
}
