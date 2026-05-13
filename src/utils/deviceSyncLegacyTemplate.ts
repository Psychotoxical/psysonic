import { IS_WINDOWS } from './platform';

// Same sanitize rules the Rust side uses (`sanitize_path_component`): strip
// Windows-illegal chars and control chars, trim leading/trailing dots + spaces.
// Kept in JS only for the migration flow — computes the *old* path under a
// user-supplied template so we can diff against the current files on disk.
export function sanitizeComponent(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
}

export interface OldTemplateTrack {
  artist: string;
  album: string;
  title: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  suffix: string;
}

/** Renders a track's path under a legacy (user-configurable) template. Used only
 *  for the migration preview — the live sync flow goes through Rust's fixed
 *  `build_track_path`. */
export function applyLegacyTemplate(template: string, track: OldTemplateTrack): string {
  const relative = template
    .replace(/\{artist\}/g,       sanitizeComponent(track.artist))
    .replace(/\{album\}/g,        sanitizeComponent(track.album))
    .replace(/\{title\}/g,        sanitizeComponent(track.title))
    .replace(/\{track_number\}/g, track.trackNumber != null ? String(track.trackNumber).padStart(2, '0') : '')
    .replace(/\{disc_number\}/g,  track.discNumber != null ? String(track.discNumber) : '')
    .replace(/\{year\}/g,         track.year != null ? String(track.year) : '');
  const withExt = `${relative}.${track.suffix}`;
  return IS_WINDOWS ? withExt.replace(/\//g, '\\') : withExt;
}
