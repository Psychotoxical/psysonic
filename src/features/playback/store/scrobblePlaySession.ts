let currentPlay: {
  trackId: string;
  serverId: string;
  startedAtMs: number;
} | null = null;

export function beginScrobblePlay(trackId: string, serverId: string): void {
  currentPlay = { trackId, serverId, startedAtMs: Date.now() };
}

export function ensureScrobblePlay(trackId: string, serverId: string): void {
  if (currentPlay?.trackId === trackId && currentPlay.serverId === serverId) return;
  beginScrobblePlay(trackId, serverId);
}

export function clearScrobblePlay(): void {
  currentPlay = null;
}

export function scrobblePlayStartedAtMs(
  trackId: string,
  serverId: string,
  currentTimeSec: number,
): number {
  if (
    currentPlay?.trackId === trackId
    && currentPlay.serverId === serverId
  ) {
    return currentPlay.startedAtMs;
  }
  const elapsedMs = Number.isFinite(currentTimeSec)
    ? Math.max(0, currentTimeSec) * 1000
    : 0;
  return Date.now() - elapsedMs;
}

export function _resetScrobblePlaySessionForTest(): void {
  clearScrobblePlay();
}
