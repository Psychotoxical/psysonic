import type { LibraryTrackDto } from '@/lib/api/library';

const MAX_SEGMENT_LEN = 120;
// eslint-disable-next-line no-control-regex -- intentional: strip C0/DEL control chars from path segments (mirrors Rust sanitize_path_segment)
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Keep path-segment rules aligned with `psysonic_core::cover_cache_layout::sanitize_path_segment`. */
function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim().replace(/[. ]+$/, '');
  if (!trimmed) return '_';
  const cleaned = trimmed.replace(FORBIDDEN, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  if (WINDOWS_RESERVED.has(cleaned.toUpperCase())) return `_${cleaned}`;
  return cleaned;
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
  const chars = [...sanitized];
  if (chars.length <= maxLen) return sanitized;
  const hash = shortHash(segment);
  const keep = maxLen - 1 - hash.length;
  return `${chars.slice(0, keep).join('')}_${hash}`;
}

function variousArtistsLabel(s: string): boolean {
  return s.trim().toLowerCase().includes('various artists');
}

function trackIsCompilation(track: Pick<LibraryTrackDto, 'artist' | 'rawJson'>): boolean {
  if (variousArtistsLabel(track.artist ?? '')) return true;
  const raw = track.rawJson;
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

function artistFolderSegment(
  track: Pick<LibraryTrackDto, 'artist' | 'albumArtist' | 'rawJson'>,
): string {
  const artist = (track.artist ?? '').trim();
  const albumArtist = (track.albumArtist ?? '').trim();
  const chosen = !artist || trackIsCompilation(track)
    ? (albumArtist || 'Various Artists')
    : artist;
  return sanitizeAndTruncate(chosen, MAX_SEGMENT_LEN);
}

function trackFilenameStem(track: Pick<LibraryTrackDto, 'title' | 'trackNumber' | 'discNumber'>): string {
  const title = (track.title ?? '').trim() || 'Unknown Title';
  const trackN = Math.max(0, track.trackNumber ?? 0);
  const discN = Math.max(0, track.discNumber ?? 1);
  if (discN > 1) {
    return `${String(discN).padStart(2, '0')}-${String(trackN).padStart(2, '0')} - ${title}`;
  }
  return `${String(trackN).padStart(2, '0')} - ${title}`;
}

/** Parity-tested with `sanitize_and_truncate_segment` in `media_layout.rs`. */
export function sanitizeAndTruncateSegment(segment: string): string {
  return sanitizeAndTruncate(segment, MAX_SEGMENT_LEN);
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
  const trackN = track.trackNumber ?? 0;
  const discN = track.discNumber ?? 0;
  const albumArtist = (track.albumArtist ?? '').trim();
  return `artist=${artistSeg}|album_artist=${albumArtist}|album=${albumSeg}|title=${(track.title ?? '').trim()}|track=${trackN}|disc=${discN}|stem=${stem}|suffix=${ext}`;
}
