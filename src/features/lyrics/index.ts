/**
 * Lyrics feature — the LyricsPane UI, the lyrics fetch/sync hooks, the
 * persistent lyrics cache, and the per-provider lyrics API clients (lrclib,
 * lyricsplus/YouLyPlus, netease). Consumed cross-feature by the queue panel,
 * the now-playing mobile view, and the fullscreen Apple-style lyrics view.
 *
 * Stays OUT (global / authStore-family, consumed beyond this feature): the
 * `lyricsStore` open/settings state (read by the keyboard-shortcut registry +
 * app boot) and `authLyricsSettingsActions` (authStore action module). The
 * subsonic 'server' lyrics provider stays in `lib/api/subsonicLyrics`.
 */
export { default as LyricsPane } from './components/LyricsPane';
export { useLyrics, type WordLyricsLine, type LyricsSource } from './hooks/useLyrics';
export { useWordLyricsSync } from './hooks/useWordLyricsSync';
export type { LrcLine } from './api/lrclib';
