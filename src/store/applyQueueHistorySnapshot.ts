import { playbackReportStart } from './playbackReportSession';
import { invoke } from '@tauri-apps/api/core';
import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { getPlaybackSourceKind } from '../utils/playback/resolvePlaybackUrl';
import {
  bumpPlayGeneration,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import { clearPreloadingIds } from './gaplessPreloadState';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import type { PlayerState, QueueItemRef } from './playerStoreTypes';
import { resolveQueueTrack } from '../utils/library/queueTrackView';
import { seedQueueResolver } from '../utils/library/queueTrackResolver';
import { canonicalQueueServerKey } from '../utils/server/serverIndexKey';
import { sameQueueTrackId } from '../utils/playback/queueIdentity';
import { queueUndoRestoreAudioEngine } from './queueUndoAudioRestore';
import {
  setPendingQueueListScrollTop,
  type QueueUndoSnapshot,
} from './queueUndo';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { refreshWaveformForTrack } from './waveformRefresh';
import { stopRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { syncQueueToServer } from './queueSync';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Apply a queue-undo snapshot to the player store and resync the Rust
 * audio engine where needed. Used by both `undoLastQueueEdit` and
 * `redoLastQueueEdit` actions inside the store.
 *
 * Behaviour matrix:
 *  - **Snapshot has no current track but playback is live** — keep the
 *    playing track and prepend it to the restored queue (or rebind by
 *    id when it's already there).
 *  - **Snapshot's current track matches the live one** — keep playback
 *    going, restore queue + position only.
 *  - **Snapshot's current track differs** — issue a full audio_play via
 *    `queueUndoRestoreAudioEngine` to put the engine on the snapshot
 *    track at the captured position.
 *
 * Returns false only when nothing changed (caller shows no toast).
 */
export function applyQueueHistorySnapshot(
  snap: QueueUndoSnapshot,
  prior: PlayerState,
  set: SetState,
  get: GetState,
): boolean {
  if (prior.currentRadio) {
    stopRadio();
  }
  // Rebuild the display queue from the snapshot's thin refs (thin-state):
  // resolver cache → placeholder. The canonical queue is the snapshot's refs;
  // this resolved `nextQueue` is only for the engine restore / normalization /
  // prepend logic below. The playing track is restored separately from the full
  // `snap.currentTrack`.
  let nextQueue = snap.queueItems.map(ref => resolveQueueTrack(ref));
  let nextItems: QueueItemRef[] = [...snap.queueItems];
  let nextIndex = snap.queueIndex;
  let nextTrack = snap.currentTrack ? { ...snap.currentTrack } : null;

  if (snap.currentTrack == null && prior.currentTrack) {
    const playing = prior.currentTrack;
    const pos = nextQueue.findIndex(t => sameQueueTrackId(t.id, playing.id));
    if (pos === -1) {
      // Prepend ref must bind to the *snapshot's* playback server (H3): a live
      // server switch racing the undo would otherwise stamp the prepended ref
      // with the new server, mis-resolving the still-playing track. Snapshot
      // fields take precedence; existing refs in the snapshot are the next
      // fallback (they share the snapshot's server); live `queueServerId` is
      // last resort. Canonical key everywhere (B1).
      const snapshotSid =
        snap.queueServerId
        ?? snap.queueItems[0]?.serverId
        ?? get().queueServerId
        ?? '';
      const prependServerId = canonicalQueueServerKey(snapshotSid);
      nextQueue = [{ ...playing }, ...nextQueue];
      nextItems = [
        { serverId: prependServerId, trackId: playing.id },
        ...nextItems,
      ];
      nextIndex = 0;
      nextTrack = { ...playing };
    } else {
      nextTrack = { ...playing };
      nextIndex = pos;
    }
  }

  nextIndex = Math.max(0, Math.min(nextIndex, Math.max(0, nextQueue.length - 1)));

  const keepPlaybackFromPrior =
    prior.currentTrack != null
    && nextTrack != null
    && sameQueueTrackId(prior.currentTrack.id, nextTrack.id)
    && nextQueue.some(t => sameQueueTrackId(t.id, prior.currentTrack!.id))
    && (
      (snap.currentTrack != null && sameQueueTrackId(prior.currentTrack.id, snap.currentTrack.id))
      || snap.currentTrack == null
    );

  if (keepPlaybackFromPrior) {
    const playingKeep = prior.currentTrack;
    if (playingKeep) {
      const idxPrior = nextQueue.findIndex(t => sameQueueTrackId(t.id, playingKeep.id));
      if (idxPrior >= 0) {
        nextIndex = idxPrior;
        nextTrack = { ...playingKeep };
      }
    }
  }

  let tRestoreRaw = typeof snap.currentTime === 'number' && Number.isFinite(snap.currentTime)
    ? snap.currentTime
    : 0;
  let playingRestore = snap.isPlaying !== false;
  if (keepPlaybackFromPrior && prior.currentTrack) {
    tRestoreRaw = prior.currentTime;
    playingRestore = prior.isPlaying;
  }
  const durForProgress = nextTrack?.duration && nextTrack.duration > 0 ? nextTrack.duration : null;
  let pRestore = typeof snap.progress === 'number' && Number.isFinite(snap.progress)
    ? snap.progress
    : (durForProgress != null && durForProgress > 0
      ? Math.max(0, Math.min(1, tRestoreRaw / durForProgress))
      : 0);
  if (keepPlaybackFromPrior) {
    pRestore = prior.progress;
  }
  const tRestore = durForProgress != null
    ? Math.max(0, Math.min(tRestoreRaw, durForProgress))
    : Math.max(0, tRestoreRaw);

  const keepWaveform =
    prior.currentTrack?.id != null &&
    nextTrack?.id != null &&
    sameQueueTrackId(prior.currentTrack.id, nextTrack.id);
  const norm =
    nextTrack != null
      ? deriveNormalizationSnapshot(nextTrack, nextQueue, nextIndex)
      : ({
          normalizationNowDb: null,
          normalizationTargetLufs: null,
          normalizationEngineLive: 'off',
        } as Pick<
          PlayerState,
          'normalizationNowDb' | 'normalizationTargetLufs' | 'normalizationEngineLive'
        >);
  const playbackSid = getPlaybackServerId();
  const playbackSourceUndo = nextTrack
    ? getPlaybackSourceKind(nextTrack.id, playbackSid, null)
    : null;
  const playbackSourceFinal = keepPlaybackFromPrior && prior.currentPlaybackSource != null
    ? prior.currentPlaybackSource
    : playbackSourceUndo;

  clearAllPlaybackScheduleTimers();
  set({
    scheduledPauseAtMs: null,
    scheduledPauseStartMs: null,
    scheduledResumeAtMs: null,
    scheduledResumeStartMs: null,
  });

  clearPreloadingIds();

  let gen = getPlayGeneration();
  const resyncEngine = Boolean(nextTrack) && !keepPlaybackFromPrior;
  if (resyncEngine || !nextTrack) {
    gen = bumpPlayGeneration();
    if (resyncEngine) {
      setIsAudioPaused(false);
    }
  }

  // Seed the resolver with the playing track so its ref always resolves (it may
  // have been prepended and not yet in the cache window). Same canonical key
  // source as the prepend above — keeps cache bucket and ref serverId in lockstep
  // even when a server switch races the undo.
  const seedSid = canonicalQueueServerKey(
    snap.queueServerId
      ?? snap.queueItems[0]?.serverId
      ?? get().queueServerId
      ?? '',
  );
  if (seedSid && nextTrack) seedQueueResolver(seedSid, [nextTrack]);
  set({
    queueItems: nextItems,
    queueIndex: nextIndex,
    currentTrack: nextTrack,
    currentRadio: null,
    currentTime: tRestore,
    progress: pRestore,
    isPlaying: playingRestore,
    waveformBins: keepWaveform ? prior.waveformBins : null,
    enginePreloadedTrackId: keepPlaybackFromPrior ? prior.enginePreloadedTrackId : null,
    currentPlaybackSource: playbackSourceFinal,
    ...norm,
  });

  if (!nextTrack) {
    invoke('audio_stop').catch(console.error);
    setIsAudioPaused(false);
    syncQueueToServer(nextItems, null, 0);
    if (typeof snap.queueListScrollTop === 'number' && Number.isFinite(snap.queueListScrollTop)) {
      setPendingQueueListScrollTop(Math.max(0, snap.queueListScrollTop));
    }
    return true;
  }

  void refreshWaveformForTrack(nextTrack.id);
  void refreshLoudnessForTrack(nextTrack.id);
  get().updateReplayGainForCurrentTrack();

  if (!keepPlaybackFromPrior) {
    playbackReportStart(nextTrack.id, getPlaybackServerId());

    queueUndoRestoreAudioEngine({
      generation: gen,
      track: nextTrack,
      queue: nextQueue,
      queueIndex: nextIndex,
      atSeconds: tRestore,
      wantPlaying: playingRestore,
    });
  }
  if (typeof snap.queueListScrollTop === 'number' && Number.isFinite(snap.queueListScrollTop)) {
    setPendingQueueListScrollTop(Math.max(0, snap.queueListScrollTop));
  }
  syncQueueToServer(nextItems, nextTrack, tRestore);
  return true;
}
