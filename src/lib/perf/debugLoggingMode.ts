/**
 * Lib-safe gate for "Settings → Logging → Debug" mode.
 *
 * The source of truth is the auth store's `loggingMode` (a higher layer), so it
 * is *injected* here via `setDebugLoggingModeSource` (called from the store at
 * module load) instead of importing the store — that keeps `src/lib` at the
 * dependency floor. Instrumentation helpers under `src/lib` (album/artist browse
 * traces, etc.) read the gate through `isDebugLoggingModeActive`. Defaults to
 * off until the store wires the source.
 */
let debugLoggingModeSource: () => boolean = () => false;

export function setDebugLoggingModeSource(source: () => boolean): void {
  debugLoggingModeSource = source;
}

export function isDebugLoggingModeActive(): boolean {
  return debugLoggingModeSource();
}
