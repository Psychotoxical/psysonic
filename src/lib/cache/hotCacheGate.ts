/** When true, hot-cache prefetch must not start new downloads (playback has priority). */
let deferHotCachePrefetch = false;

/** Last track that was «current» before a forward queue step — not evicted until debounce elapses. */
let previousTrackGraceUntilMs = 0;
let previousTrackGraceTrackId: string | null = null;
let previousTrackGraceServerId: string | null = null;

export function setDeferHotCachePrefetch(v: boolean): void {
  deferHotCachePrefetch = v;
}

export function getDeferHotCachePrefetch(): boolean {
  return deferHotCachePrefetch;
}

/** Call when `queueIndex` advances; the old current track stays eviction-safe for `debounceSec` (capped at 600 s). */
export function bumpHotCachePreviousTrackGrace(
  trackId: string,
  serverId: string,
  debounceSec: number,
): void {
  const sec = Number.isFinite(debounceSec) ? Math.min(600, Math.max(0, debounceSec)) : 0;
  previousTrackGraceUntilMs = Date.now() + sec * 1000;
  previousTrackGraceTrackId = trackId;
  previousTrackGraceServerId = serverId;
}

export function isHotCachePreviousTrackUnderGrace(trackId: string, serverId: string): boolean {
  if (!previousTrackGraceTrackId || Date.now() >= previousTrackGraceUntilMs) return false;
  return previousTrackGraceTrackId === trackId && previousTrackGraceServerId === serverId;
}

export function clearHotCachePreviousGrace(): void {
  previousTrackGraceUntilMs = 0;
  previousTrackGraceTrackId = null;
  previousTrackGraceServerId = null;
}
