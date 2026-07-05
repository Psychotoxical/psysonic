// Playback-engine bridge. Global settings/profile stores (authStore family) need
// to trigger a few engine effects — clear a deleted server's queue binding, catch
// the current track up to a changed ReplayGain/normalization mode — but those
// stores are core and must not import the playback engine (iron rule; the engine
// will live in @/features/playback). The engine registers its operations here at
// boot (playbackEngineBridgeRegister.ts, side-effect-imported by MainApp); core
// callers invoke these neutral delegators.
//
// Default (unregistered) = no-op / null. Safe: the only callers are user-triggered
// settings/profile actions that fire long after boot, by which point the engine
// (loaded at app start) has registered. At boot there is no current track or queue
// binding, so the no-op default would be correct even if it were ever reached.

export interface PlaybackEngineBridge {
  /** Active queue's bound server id, or null when nothing is bound. */
  getQueueServerId(): string | null;
  /** Drop the queue's server binding (used when its server profile is deleted). */
  clearQueueServerForPlayback(): void;
  /** Re-apply ReplayGain/normalization to the currently playing track. */
  updateReplayGainForCurrentTrack(): void;
}

let bridge: PlaybackEngineBridge | null = null;

export function registerPlaybackEngineBridge(impl: PlaybackEngineBridge): void {
  bridge = impl;
}

/** True once the engine installs its operations. For the boot-registration smoke guard. */
export function isPlaybackEngineBridgeRegistered(): boolean {
  return bridge !== null;
}

export function getQueueServerId(): string | null {
  return bridge ? bridge.getQueueServerId() : null;
}

export function clearQueueServerForPlayback(): void {
  bridge?.clearQueueServerForPlayback();
}

export function updateReplayGainForCurrentTrack(): void {
  bridge?.updateReplayGainForCurrentTrack();
}
