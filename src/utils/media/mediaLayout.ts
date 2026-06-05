import type { LibraryTrackDto } from '../../api/library';

const MAX_SEGMENT_LEN = 120;
const FORBIDDEN = /[\\/:*?"<>|]/g;

function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return '_';
  return trimmed.replace(FORBIDDEN, '_');
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

function sanitizeAndTruncate(segment: string, maxLen: number): string {
  const sanitized = sanitizeSegment(segment);
  if (sanitized.length <= maxLen) return sanitized;
  const hash = shortHash(segment);
  const keep = maxLen - 1 - hash.length;
  return `${sanitized.slice(0, keep)}_${hash}`;
}

function variousArtistsLabel(s: string): boolean {
  return s.trim().toLowerCase().includes('various artists');
}

function trackIsCompilation(track: Pick<LibraryTrackDto, 'artist' | 'raw_json'>): boolean {
  if (variousArtistsLabel(track.artist ?? '')) return true;
  const raw = track.raw_json;
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (obj.isCompilation === true) return true;
  if (obj.compilation === true || obj.compilation === 1 || obj.compilation === '1') return true;
  const releaseTypes = obj.releaseTypes;
  if (Array.isArray(releaseTypes)) {
    return releaseTypes.some(
      rt => typeof rt === 'string' && rt.toLowerCase() === 'compilation',
    );
  }
  return false;
}

function artistFolderSegment(track: Pick<LibraryTrackDto, 'artist' | 'album_artist'>): string {
  const artist = (track.artist ?? '').trim();
  const albumArtist = (track.album_artist ?? '').trim();
  const chosen = !artist || trackIsCompilation(track)
    ? (albumArtist || 'Various Artists')
    : artist;
  return sanitizeAndTruncate(chosen, MAX_SEGMENT_LEN);
}

function trackFilenameStem(track: Pick<LibraryTrackDto, 'title' | 'track_number' | 'disc_number'>): string {
  const title = (track.title ?? '').trim() || 'Unknown Title';
  const trackN = Math.max(0, track.track_number ?? 0);
  const discN = Math.max(0, track.disc_number ?? 1);
  if (discN > 1) {
    return `${String(discN).padStart(2, '0')}-${String(trackN).padStart(2, '0')} - ${title}`;
  }
  return `${String(trackN).padStart(2, '0')} - ${title}`;
}

/** Stable fingerprint — keep in sync with `psysonic_core::media_layout::layout_fingerprint`. */
export function layoutFingerprintFromLibraryTrack(
  track: LibraryTrackDto,
  suffix?: string,
): string {
  const artistSeg = artistFolderSegment(track);
  const albumSeg = sanitizeAndTruncate((track.album ?? '').trim() || 'Unknown Album', MAX_SEGMENT_LEN);
  const stem = trackFilenameStem(track);
  const ext = (suffix ?? track.suffix ?? '').trim();
  const trackN = track.track_number ?? 0;
  const discN = track.disc_number ?? 0;
  const albumArtist = (track.album_artist ?? '').trim();
  return `artist=${artistSeg}|album_artist=${albumArtist}|album=${albumSeg}|title=${(track.title ?? '').trim()}|track=${trackN}|disc=${discN}|stem=${stem}|suffix=${ext}`;
}
