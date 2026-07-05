import type { Track } from '@/lib/media/trackTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';
import {
  libraryRecordPlaySession,
  type PlaySessionEndReason,
} from '@/lib/api/library';
import { libraryIsReady } from '@/lib/library/libraryReady';
import { getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import { emitPlaySessionRecorded } from '@/features/playback/store/playSessionRecorded';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

const MIN_LISTENED_SEC = 10;

type OpenSession = {
  serverId: string;
  trackId: string;
  startedAtMs: number;
  listenedSec: number;
  positionMaxSec: number;
  durationSecHint: number;
  lastTickMs: number;
  recordingEnabled: boolean;
  paused: boolean;
};

let open: OpenSession | null = null;
let finalizeInFlight: Promise<void> | null = null;

function clearOpen(): void {
  open = null;
}

/** Best-known track length in seconds from player metadata and/or engine. */
export function resolveDurationSecHint(
  track: Pick<Track, 'duration'> | null | undefined,
  ...extraSec: (number | undefined)[]
): number {
  const values = [track?.duration, ...extraSec].filter(
    (d): d is number => typeof d === 'number' && Number.isFinite(d) && d > 0,
  );
  if (values.length === 0) return 0;
  return Math.round(Math.max(...values));
}

function noteDurationHint(durationSec?: number): void {
  if (!open || !durationSec || durationSec <= 0) return;
  const rounded = Math.round(durationSec);
  if (rounded > open.durationSecHint) {
    open.durationSecHint = rounded;
  }
}

function playerGateBlocks(): boolean {
  if (usePreviewStore.getState().previewingId) return true;
  if (usePlayerStore.getState().currentRadio) return true;
  return false;
}

async function recordingEnabledForServer(serverId: string): Promise<boolean> {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  if (playerGateBlocks()) return false;
  return libraryIsReady(serverId);
}

export async function playListenSessionOpen(
  track: Track,
  serverId: string,
  engineDurationSec?: number,
): Promise<void> {
  if (open && open.trackId === track.id && open.serverId === serverId) {
    noteDurationHint(resolveDurationSecHint(track, engineDurationSec));
    return;
  }
  await playListenSessionFinalize('skip');
  const enabled = await recordingEnabledForServer(serverId);
  if (!enabled) return;
  open = {
    serverId,
    trackId: track.id,
    startedAtMs: Date.now(),
    listenedSec: 0,
    positionMaxSec: 0,
    durationSecHint: resolveDurationSecHint(track, engineDurationSec),
    lastTickMs: Date.now(),
    recordingEnabled: true,
    paused: false,
  };
}

/**
 * Freeze the listening counter when transport pauses. While paused the Rust
 * engine stops feeding active progress ticks to the session, so without this
 * the next tick after resume would compute its wall-clock delta against the
 * pre-pause timestamp and bill the entire paused span as listened time. We
 * settle the partial segment played since the last tick, then mark the session
 * paused so the first resumed tick rebaselines instead of counting the gap.
 */
export function playListenSessionOnPause(): void {
  if (!open?.recordingEnabled || open.paused) return;
  const now = Date.now();
  open.listenedSec += Math.max(0, (now - open.lastTickMs) / 1000);
  open.lastTickMs = now;
  open.paused = true;
}

export async function playListenSessionOnProgress(
  currentTime: number,
  buffering: boolean,
  durationSecHint?: number,
): Promise<void> {
  if (!open?.recordingEnabled) return;
  noteDurationHint(durationSecHint);
  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (track?.id === open.trackId) {
    noteDurationHint(resolveDurationSecHint(track, durationSecHint));
  }
  if (!store.isPlaying || buffering) {
    open.lastTickMs = Date.now();
    return;
  }
  const now = Date.now();
  if (open.paused) {
    // First tick after resume — rebaseline so the paused gap is not billed.
    open.paused = false;
    open.lastTickMs = now;
  }
  const deltaSec = Math.max(0, (now - open.lastTickMs) / 1000);
  open.lastTickMs = now;
  open.listenedSec += deltaSec;
  if (Number.isFinite(currentTime) && currentTime > open.positionMaxSec) {
    open.positionMaxSec = currentTime;
  }
}

export async function playListenSessionFinalize(reason: PlaySessionEndReason): Promise<void> {
  if (finalizeInFlight) {
    await finalizeInFlight;
  }
  if (!open) return;

  const session = open;
  clearOpen();

  if (!session.recordingEnabled || session.listenedSec <= MIN_LISTENED_SEC) {
    return;
  }

  const track = usePlayerStore.getState().currentTrack;
  const durationSecHint = resolveDurationSecHint(
    track?.id === session.trackId ? track : null,
    session.durationSecHint,
  );

  finalizeInFlight = libraryRecordPlaySession({
    serverId: session.serverId,
    trackId: session.trackId,
    startedAtMs: session.startedAtMs,
    listenedSec: session.listenedSec,
    positionMaxSec: session.positionMaxSec,
    endReason: reason,
    durationSecHint: durationSecHint > 0 ? durationSecHint : undefined,
  })
    .then(() => {
      emitPlaySessionRecorded({
        serverId: session.serverId,
        trackId: session.trackId,
        startedAtMs: session.startedAtMs,
      });
    })
    .catch(() => undefined)
    .finally(() => {
      finalizeInFlight = null;
    });

  await finalizeInFlight;
}

export async function playListenSessionOnTrackSwitched(nextTrack: Track): Promise<void> {
  const serverId = getPlaybackServerId();
  await playListenSessionFinalize('switch');
  await playListenSessionOpen(nextTrack, serverId, nextTrack.duration);
}

/** Test-only reset */
export function _resetPlayListenSessionForTest(): void {
  open = null;
  finalizeInFlight = null;
}
