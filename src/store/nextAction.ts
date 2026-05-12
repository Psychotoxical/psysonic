import { invoke } from '@tauri-apps/api/core';
import { getSimilarSongs2, getTopSongs } from '../api/subsonic';
import { buildInfiniteQueueCandidates } from '../utils/buildInfiniteQueueCandidates';
import { songToTrack } from '../utils/songToTrack';
import { useAuthStore } from './authStore';
import { setIsAudioPaused } from './engineState';
import {
  isInfiniteQueueFetching,
  setInfiniteQueueFetching,
} from './infiniteQueueState';
import { isInOrbitSession } from './orbitSession';
import type { PlayerState, Track } from './playerStoreTypes';
import {
  addRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  isRadioFetching,
  setRadioFetching,
} from './radioSessionState';
import { applySkipStarOnManualNext } from './skipStarRating';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Advance to the next track. Three top-level outcomes:
 *
 * 1. **Has next slot** — `playTrack` the queue's `queueIndex + 1`,
 *    then proactively top up auto-added (infinite-queue) and
 *    radio-added tracks when ≤ 2 of each remain ahead. Both top-ups
 *    are skipped inside an Orbit session — the host owns the queue,
 *    and a silent local extension would drift the guest off the host
 *    or pop the bulk-add modal at the next track-end fallback.
 *
 * 2. **Queue exhausted, repeat=all** — wrap back to index 0.
 *
 * 3. **Queue exhausted, repeat=off** — stop, unless:
 *    - The current track is radio-flagged → fetch a fresh radio batch
 *      and continue.
 *    - Infinite queue is enabled → fetch more candidates and continue.
 *    - Orbit session active → stop locally and let `useOrbitGuest`
 *      sync to the host's next track.
 */
export function runNext(set: SetState, get: GetState, manual: boolean): void {
  const { queue, queueIndex, repeatMode, currentTrack } = get();
  applySkipStarOnManualNext(currentTrack, manual);
  const nextIdx = queueIndex + 1;
  if (nextIdx < queue.length) {
    get().playTrack(queue[nextIdx], queue, manual, false, nextIdx);
    // Proactively top up auto-added tracks when ≤ 2 remain ahead,
    // so the queue never runs dry without a visible loading pause.
    // Skipped while in Orbit — the host's queue is the source of
    // truth there, and any silent local extension would either
    // drift this client off the host or pop the bulk-add modal at
    // the next track-end fallback.
    const { infiniteQueueEnabled } = useAuthStore.getState();
    if (infiniteQueueEnabled && repeatMode === 'off' && !isInfiniteQueueFetching() && !isInOrbitSession()) {
      const remainingAuto = queue.slice(nextIdx + 1).filter(t => t.autoAdded).length;
      if (remainingAuto <= 2) {
        setInfiniteQueueFetching(true);
        const existingIds = new Set(get().queue.map(t => t.id));
        buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
          // Re-check at resolution time — the user may have joined
          // an Orbit session between scheduling and resolving.
          if (isInOrbitSession()) return;
          if (newTracks.length > 0) {
            set(state => ({ queue: [...state.queue, ...newTracks] }));
          }
        }).catch(() => {}).finally(() => { setInfiniteQueueFetching(false); });
      }
    }
    // Proactively top up radio tracks when ≤ 2 remain — always, regardless
    // of infinite queue setting.
    const nextTrack = queue[nextIdx];
    if (nextTrack.radioAdded && !isRadioFetching()) {
      const remainingRadio = queue.slice(nextIdx + 1).filter(t => t.radioAdded).length;
      if (remainingRadio <= 2) {
        const artistId = nextTrack.artistId ?? getCurrentRadioArtistId() ?? null;
        const artistName = nextTrack.artist;
        if (artistId) {
          setRadioFetching(true);
          Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)])
            .then(([similar, top]) => {
              const existingIds = new Set(get().queue.map(t => t.id));
              // Lead with similar (other artists) for variety; top tracks
              // of the upcoming artist are only a fallback when similar
              // is empty. Single-pass loop dedupes against the live queue,
              // the session seen-set, and intra-batch overlap (issue #500).
              const sourceList = similar.length > 0 ? similar : top;
              const fresh: Track[] = [];
              for (const raw of sourceList) {
                if (fresh.length >= 10) break;
                const t = songToTrack(raw);
                if (existingIds.has(t.id) || hasRadioSessionSeen(t.id)) continue;
                addRadioSessionSeen(t.id);
                fresh.push({ ...t, radioAdded: true as const });
              }
              if (fresh.length > 0) {
                // Trim played tracks from the front to keep the queue bounded.
                // Without trimming the queue grows unboundedly, making every
                // Zustand persist write larger and causing UI freezes over time.
                // Keep the last HISTORY_KEEP played tracks so the user can still
                // navigate backwards a few songs. Trimmed ids stay in the seen-set.
                const HISTORY_KEEP = 5;
                set(state => {
                  const trimStart = Math.max(0, state.queueIndex - HISTORY_KEEP);
                  return {
                    queue: [...state.queue.slice(trimStart), ...fresh],
                    queueIndex: state.queueIndex - trimStart,
                  };
                });
              }
            })
            .catch(() => {})
            .finally(() => { setRadioFetching(false); });
        }
      }
    }
  } else if (repeatMode === 'all' && queue.length > 0) {
    get().playTrack(queue[0], queue, manual, false, 0);
  } else {
    // ── Orbit short-circuit ──
    // The host owns the shared queue. The radio / infinite-queue
    // fallbacks below would either pop the orbitBulkGuard modal (with a
    // 6-track add) or silently inject unrelated tracks into the local
    // player and drift the guest off the host. Stop instead and let the
    // next pull tick in `useOrbitGuest` sync to the host's next track.
    // Covers any active orbit phase (`active` / `joining` / `starting`)
    // so a fetch scheduled mid-join doesn't slip through.
    if (isInOrbitSession()) {
      invoke('audio_stop').catch(console.error);
      setIsAudioPaused(false);
      set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
      return;
    }
    // Queue exhausted. Check radio first (independent of infinite queue setting),
    // then infinite queue, then stop.
    if (currentTrack?.radioAdded && !isRadioFetching()) {
      const artistId = currentTrack.artistId ?? getCurrentRadioArtistId() ?? null;
      if (artistId) {
        setRadioFetching(true);
        Promise.all([getSimilarSongs2(artistId), getTopSongs(currentTrack.artist)])
          .then(([similar, top]) => {
            setRadioFetching(false);
            // The user may have joined an Orbit session while this
            // fetch was in flight — bail without touching the queue.
            if (isInOrbitSession()) {
              invoke('audio_stop').catch(console.error);
              setIsAudioPaused(false);
              set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
              return;
            }
            const existingIds = new Set(get().queue.map(t => t.id));
            // Same source preference + dedup contract as the proactive
            // top-up: similar first, top only as a fallback (issue #500).
            const sourceList = similar.length > 0 ? similar : top;
            const fresh: Track[] = [];
            for (const raw of sourceList) {
              if (fresh.length >= 10) break;
              const t = songToTrack(raw);
              if (existingIds.has(t.id) || hasRadioSessionSeen(t.id)) continue;
              addRadioSessionSeen(t.id);
              fresh.push({ ...t, radioAdded: true as const });
            }
            if (fresh.length > 0) {
              const currentQueue = get().queue;
              const newQueue = [...currentQueue, ...fresh];
              get().playTrack(fresh[0], newQueue, false, false, currentQueue.length);
            } else {
              invoke('audio_stop').catch(console.error);
              setIsAudioPaused(false);
              set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
            }
          })
          .catch(() => {
            setRadioFetching(false);
            invoke('audio_stop').catch(console.error);
            setIsAudioPaused(false);
            set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
          });
        return;
      }
    }
    const { infiniteQueueEnabled } = useAuthStore.getState();
    if (infiniteQueueEnabled && repeatMode === 'off') {
      if (isInfiniteQueueFetching()) return;
      setInfiniteQueueFetching(true);
      const existingIds = new Set(get().queue.map(t => t.id));
      buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
        setInfiniteQueueFetching(false);
        // The user may have joined an Orbit session while this
        // fetch was in flight — bail without invoking playTrack.
        if (isInOrbitSession()) {
          invoke('audio_stop').catch(console.error);
          setIsAudioPaused(false);
          set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
          return;
        }
        if (newTracks.length === 0) {
          invoke('audio_stop').catch(console.error);
          setIsAudioPaused(false);
          set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
          return;
        }
        const currentQueue = get().queue;
        const newQueue = [...currentQueue, ...newTracks];
        get().playTrack(newTracks[0], newQueue, false);
      }).catch(() => {
        setInfiniteQueueFetching(false);
        invoke('audio_stop').catch(console.error);
        setIsAudioPaused(false);
        set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
      });
    } else {
      invoke('audio_stop').catch(console.error);
      setIsAudioPaused(false);
      set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
    }
  }
}
