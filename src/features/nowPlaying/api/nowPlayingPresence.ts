import type { SubsonicNowPlaying } from '@/lib/api/subsonicTypes';

/**
 * Derived liveness of a now-playing entry, surfaced as the indicator dot in the
 * "Who is listening?" popover. Unifies the two sources the server can provide:
 * the OpenSubsonic `playbackReport` transport state (Navidrome ≥ 0.62, when
 * present) and the classic `getNowPlaying` `minutesAgo` recency (legacy
 * fallback). This replaces rendering the raw "Nm ago" line.
 */
export type NowPlayingPresence = 'playing' | 'paused' | 'idle';

/**
 * Minutes since last activity beyond which a legacy entry (one without
 * playbackReport transport state) is treated as idle rather than actively
 * playing. Entries that carry a live `state` ignore this entirely.
 */
export const NOW_PLAYING_IDLE_MINUTES = 5;

/** Resolve the liveness an entry should display. Live `state` is authoritative;
 *  otherwise recency (`minutesAgo`) decides playing vs idle. */
export function nowPlayingPresence(entry: SubsonicNowPlaying): NowPlayingPresence {
  // playbackReport extension: trust the reported transport state.
  switch (entry.state) {
    case 'playing':
    case 'starting':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'stopped':
      return 'idle';
  }
  // Legacy getNowPlaying: only recency is known. Recent = playing, stale = idle.
  return entry.minutesAgo > NOW_PLAYING_IDLE_MINUTES ? 'idle' : 'playing';
}
