/**
 * Lib-safe gate for "Settings → Logging → Debug" mode and detail depth.
 *
 * The source of truth is the auth store's `loggingMode` and
 * `debugLoggingDepth` (a higher layer), so both are injected here at module load
 * instead of importing the store. That keeps `src/lib` at the dependency floor.
 * Instrumentation helpers read the mode and depth gates independently; defaults
 * are off and depth 1 until the store wires the sources.
 */
export type DebugLoggingDepth = 1 | 3;

let debugLoggingModeSource: () => boolean = () => false;
let debugLoggingDepthSource: () => DebugLoggingDepth = () => 1;

export function setDebugLoggingModeSource(source: () => boolean): void {
  debugLoggingModeSource = source;
}

export function setDebugLoggingDepthSource(source: () => DebugLoggingDepth): void {
  debugLoggingDepthSource = source;
}

export function isDebugLoggingModeActive(): boolean {
  return debugLoggingModeSource();
}

export function isDebugLoggingDepthEnabled(requiredDepth: DebugLoggingDepth = 1): boolean {
  return debugLoggingDepthSource() >= requiredDepth;
}

export function sanitizeDebugLoggingDepth(value: unknown): DebugLoggingDepth {
  return value === 3 ? value : 1;
}
