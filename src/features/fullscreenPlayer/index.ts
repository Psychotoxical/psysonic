/**
 * Fullscreen player feature — the immersive full-window now-playing view
 * (artwork, Apple-style synced lyrics, clock, transport, queue modal) rendered
 * by the app shell. Its sub-components (Fs*) are internal.
 *
 * Note: `hooks/useWindowFullscreenState` is NOT part of this feature — it tracks
 * the OS window's fullscreen state (app-shell concern), not this player view.
 */
export { default } from './components/FullscreenPlayerStatic';
