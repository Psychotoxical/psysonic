import { getSimilarSongs2, getTopSongs } from '@/lib/api/subsonicArtists';
import { audioStop } from '@/lib/api/audio';
import { buildInfiniteQueueCandidates } from '@/features/playback/utils/playback/buildInfiniteQueueCandidates';
import { songToTrack } from '@/lib/media/songToTrack';
import { ensureQueueServerPinned } from '@/features/playback/utils/playback/playbackServer';
import { useAuthStore } from '@/store/authStore';
import { setIsAudioPaused } from '@/features/playback/store/engineState';
import {
  isInfiniteQueueFetching,
  setInfiniteQueueFetching,
} from '@/features/playback/store/infiniteQueueState';
import { isInOrbitSession } from '@/store/orbitRuntime';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import {
  addRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  isRadioFetching,
  setRadioFetching,
} from '@/features/playback/store/radioSessionState';
import { finalizePlayQueueAtTrackEnd } from '@/features/playback/store/queueSync';
import { applySkipStarOnManualNext } from '@/features/playback/store/skipStarRating';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Queue-exhausted radio / infinite-queue refill: append the freshly fetched
 * tracks to the canonical `queueItems`, seed the resolver with them (so they
 * resolve without a network round-trip), then play the first appended track at
 * its new tail index. Refs in / Track for the play call only — thin-state.
 */
function appendTracksAndPlayFirst(set: SetState, get: GetState, fresh: Track[]): void {
  if (fresh.length === 0) return;
  // Pin the server *before* reading state so the appended refs (and the
  // resolver seed) carry the canonical server key — otherwise queue rows for
  // the appended tracks render as the resolver placeholder. See PR #892.
  const serverId = ensureQueueServerPinned();
  const state = get();
  if (serverId) seedQueueResolver(serverId, fresh);
  const incoming: QueueItemRef[] = toQueueItemRefs(serverId, fresh);
  const playAt = state.queueItems.length;
  // Append the refs first so playTrack (queue arg undefined) reads them off the
  // canonical list and its targetQueueIndex validates against the new tail.
  set({ queueItems: [...state.queueItems, ...incoming] });
  get().playTrack(fresh[0], undefined, false, false, playAt);
}

/** Repeat-off queue tail: stop transport and finalize server play queue at EOF. */
function stopAtNaturalQueueEnd(set: SetState, get: GetState): void {
  const { currentTrack, queueItems } = get();
  if (currentTrack && queueItems.length > 0) {
    void finalizePlayQueueAtTrackEnd(queueItems, currentTrack);
  }
  audioStop().catch(console.error);
  setIsAudioPaused(false);
  set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
}

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
  const { queueItems, queueIndex, repeatMode, currentTrack } = get();
  applySkipStarOnManualNext(currentTrack, manual);
  const nextIdx = queueIndex + 1;
  if (nextIdx < queueItems.length) {
    // Resolver bridge keeps the [queueIndex-50, +200] window warm, so the next
    // ref is cache-hot here; resolveQueueTrack falls back to a placeholder
    // (carrying the correct trackId) on a cold miss so playback still starts.
    const nextRef = queueItems[nextIdx];
    const nextTrack = resolveQueueTrack(nextRef);
    get().playTrack(nextTrack, undefined, manual, false, nextIdx);
    // Proactively top up auto-added tracks when ≤ 2 remain ahead,
    // so the queue never runs dry without a visible loading pause.
    // Skipped while in Orbit — the host's queue is the source of
    // truth there, and any silent local extension would either
    // drift this client off the host or pop the bulk-add modal at
    // the next track-end fallback.
    const { infiniteQueueEnabled } = useAuthStore.getState();
    if (infiniteQueueEnabled && repeatMode === 'off' && !isInfiniteQueueFetching() && !isInOrbitSession()) {
      const remainingAuto = queueItems.slice(nextIdx + 1).filter(r => r.autoAdded).length;
      if (remainingAuto <= 2) {
        setInfiniteQueueFetching(true);
        const existingIds = new Set(get().queueItems.map(r => r.trackId));
        buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
          // Re-check at resolution time — the user may have joined
          // an Orbit session between scheduling and resolving.
          if (isInOrbitSession()) return;
          if (newTracks.length > 0) {
            // Pin before set so the appended refs carry the canonical server
            // key; without this the auto-added rows render as '…' / 0:00
            // when the queue was populated without a queue-replacing playTrack
            // (see PR #892).
            const serverId = ensureQueueServerPinned();
            set(state => {
              if (serverId) seedQueueResolver(serverId, newTracks);
              const newItems = [...state.queueItems, ...toQueueItemRefs(serverId, newTracks)];
              return { queueItems: newItems };
            });
          }
        }).catch(() => {}).finally(() => { setInfiniteQueueFetching(false); });
      }
    }
    // Proactively top up radio tracks when ≤ 2 remain — independent of the
    // infinite-queue setting, but still skipped in Orbit: the radio top-up
    // appends unrelated tracks and trims queue history, which would drift a
    // guest off the host's playlist (same rationale as the infinite-queue
    // branch above).
    if (nextRef.radioAdded && !isRadioFetching() && !isInOrbitSession()) {
      const remainingRadio = queueItems.slice(nextIdx + 1).filter(r => r.radioAdded).length;
      if (remainingRadio <= 2) {
        // H2: nextTrack may be a placeholder if its ref is still cold — empty
        // artist/artistId would seed `getSimilarSongs2('')` and silently
        // return nothing, leaving radio dry. Prefer the just-played
        // currentTrack (always fully resolved in playerStore) and the stored
        // radio seed artist; fall back to nextTrack metadata only when those
        // are missing. Skip the top-up entirely when no stable seed exists
        // rather than firing a non-deterministic empty request.
        const seedArtistId =
          currentTrack?.artistId
          ?? getCurrentRadioArtistId()
          ?? nextTrack.artistId
          ?? null;
        const seedArtistName = currentTrack?.artist || nextTrack.artist;
        if (seedArtistId && seedArtistName) {
          setRadioFetching(true);
          Promise.all([getSimilarSongs2(seedArtistId), getTopSongs(seedArtistName)])
            .then(([similar, top]) => {
              // Re-check — the user may have joined an Orbit session between
              // scheduling this fetch and its resolution (mirrors the
              // infinite-queue branch). The finally() still clears the flag.
              if (isInOrbitSession()) return;
              const existingIds = new Set(get().queueItems.map(r => r.trackId));
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
                // Pin before set; same reasoning as the infinite top-up above.
                const serverId = ensureQueueServerPinned();
                set(state => {
                  if (serverId) seedQueueResolver(serverId, fresh);
                  const trimStart = Math.max(0, state.queueIndex - HISTORY_KEEP);
                  const newItems = [
                    ...state.queueItems.slice(trimStart),
                    ...toQueueItemRefs(serverId, fresh),
                  ];
                  return {
                    queueItems: newItems,
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
  } else if (repeatMode === 'all' && queueItems.length > 0) {
    const firstTrack = resolveQueueTrack(queueItems[0]);
    get().playTrack(firstTrack, undefined, manual, false, 0);
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
      audioStop().catch(console.error);
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
              audioStop().catch(console.error);
              setIsAudioPaused(false);
              set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
              return;
            }
            const existingIds = new Set(get().queueItems.map(r => r.trackId));
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
              appendTracksAndPlayFirst(set, get, fresh);
            } else {
              stopAtNaturalQueueEnd(set, get);
            }
          })
          .catch(() => {
            setRadioFetching(false);
            stopAtNaturalQueueEnd(set, get);
          });
        return;
      }
    }
    const { infiniteQueueEnabled } = useAuthStore.getState();
    if (infiniteQueueEnabled && repeatMode === 'off') {
      if (isInfiniteQueueFetching()) return;
      setInfiniteQueueFetching(true);
      const existingIds = new Set(get().queueItems.map(r => r.trackId));
      buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
        setInfiniteQueueFetching(false);
        // The user may have joined an Orbit session while this
        // fetch was in flight — bail without invoking playTrack.
        if (isInOrbitSession()) {
          audioStop().catch(console.error);
          setIsAudioPaused(false);
          set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
          return;
        }
        if (newTracks.length === 0) {
          stopAtNaturalQueueEnd(set, get);
          return;
        }
        appendTracksAndPlayFirst(set, get, newTracks);
      }).catch(() => {
        setInfiniteQueueFetching(false);
        stopAtNaturalQueueEnd(set, get);
      });
    } else {
      stopAtNaturalQueueEnd(set, get);
    }
  }
}
