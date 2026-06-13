import { reportNowPlaying, reportPlayback } from '../api/subsonicScrobble';
import type { PlaybackReportState } from '../api/subsonicTypes';
import { FEATURE_PLAYBACK_REPORT } from '../serverCapabilities/catalog';
import { isFeatureActiveForServer } from '../serverCapabilities/storeView';
import { isPlaybackRateApplied } from '../utils/audio/playbackRateHelpers';
import { isOrbitPlaybackSyncActive } from '../utils/orbit';
import { useAuthStore } from './authStore';
import { getPlaybackProgressSnapshot } from './playbackProgress';
import { usePlaybackRateStore } from './playbackRateStore';

/**
 * Live now-playing presence on the Subsonic server channel.
 *
 * When the server advertises the OpenSubsonic `playbackReport` extension
 * (Navidrome ≥ 0.62) we drive a small playback state machine — starting →
 * playing ↔ paused → stopped — that mirrors the lifecycle hooks already used by
 * `playListenSession`. This gives `getNowPlaying` a real transport state and an
 * extrapolated position. `ignoreScrobble=true` keeps the server from applying
 * scrobble / play-count side effects, because psysonic still owns play counts on
 * the dedicated `scrobble.view` channel (the 50% rule in `audioEventHandlers`).
 *
 * On servers without the extension every entry point degrades to the legacy
 * `scrobble.view?submission=false` presence call (`reportNowPlaying`), so the
 * behaviour is unchanged there. All presence reporting stays gated on the
 * existing `nowPlayingEnabled` master toggle.
 */

type ReportSession = { serverId: string; trackId: string };

let session: ReportSession | null = null;

function nowPlayingEnabled(): boolean {
  return useAuthStore.getState().nowPlayingEnabled;
}

function extensionActive(serverId: string): boolean {
  return isFeatureActiveForServer(serverId, FEATURE_PLAYBACK_REPORT);
}

/** Effective playback speed sent to the server (1.0 when the speed DSP is off). */
function effectivePlaybackRate(): number {
  const { enabled, strategy, speed, pitchSemitones } = usePlaybackRateStore.getState();
  return isPlaybackRateApplied(enabled, strategy, speed, pitchSemitones, isOrbitPlaybackSyncActive())
    ? speed
    : 1.0;
}

function positionMs(explicitSec?: number): number {
  const sec = explicitSec ?? getPlaybackProgressSnapshot().currentTime;
  return Math.max(0, Math.floor((Number.isFinite(sec) ? sec : 0) * 1000));
}

function send(
  serverId: string,
  trackId: string,
  state: PlaybackReportState,
  explicitSec?: number,
): Promise<void> {
  return reportPlayback(serverId, {
    mediaId: trackId,
    positionMs: positionMs(explicitSec),
    state,
    playbackRate: effectivePlaybackRate(),
    ignoreScrobble: true,
  });
}

/**
 * Track start / gapless switch / queue restore. Replaces the direct
 * `reportNowPlaying` presence call at those sites: the extension path opens the
 * FSM (starting → playing); otherwise the legacy presence call is used.
 */
export function playbackReportStart(trackId: string, serverId: string): void {
  if (!serverId || !nowPlayingEnabled()) return;
  if (!extensionActive(serverId)) {
    void reportNowPlaying(trackId, serverId);
    return;
  }
  const isNewSession = !session || session.trackId !== trackId || session.serverId !== serverId;
  session = { serverId, trackId };
  if (isNewSession) {
    void send(serverId, trackId, 'starting').then(() => send(serverId, trackId, 'playing'));
  } else {
    void send(serverId, trackId, 'playing');
  }
}

/** Engine-confirmed playback / resume / heartbeat (extension path only). */
export function playbackReportPlaying(explicitSec?: number): void {
  if (!session || !nowPlayingEnabled() || !extensionActive(session.serverId)) return;
  void send(session.serverId, session.trackId, 'playing', explicitSec);
}

/** Transport paused (extension path only). */
export function playbackReportPaused(explicitSec?: number): void {
  if (!session || !nowPlayingEnabled() || !extensionActive(session.serverId)) return;
  void send(session.serverId, session.trackId, 'paused', explicitSec);
}

/** Seek settled — report the new position with the current transport state. */
export function playbackReportSeek(explicitSec: number, isPlaying: boolean): void {
  if (!session || !nowPlayingEnabled() || !extensionActive(session.serverId)) return;
  void send(session.serverId, session.trackId, isPlaying ? 'playing' : 'paused', explicitSec);
}

/**
 * Playback stopped (manual stop / ended / error / app quit). Clears the session
 * and tells the server to drop the now-playing entry. Returns the in-flight
 * request so the exit flow can race it against a timeout.
 */
export function playbackReportStopped(explicitSec?: number): Promise<void> {
  if (!session) return Promise.resolve();
  const { serverId, trackId } = session;
  session = null;
  if (!extensionActive(serverId)) return Promise.resolve();
  return send(serverId, trackId, 'stopped', explicitSec);
}

/** Test-only reset. */
export function _resetPlaybackReportSessionForTest(): void {
  session = null;
}
