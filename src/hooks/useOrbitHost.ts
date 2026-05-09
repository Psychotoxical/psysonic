import { useEffect, useRef } from 'react';
import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { getSong } from '../api/subsonic';
import {
  writeOrbitState,
  writeOrbitHeartbeat,
  sweepGuestOutboxes,
  applyOutboxSnapshotsToState,
  maybeShuffleQueue,
  effectiveShuffleIntervalMs,
  suggestionKey,
} from '../utils/orbit';
import {
  orbitOutboxPlaylistName,
  ORBIT_PLAY_QUEUE_LIMIT,
  type OrbitState,
  type OrbitQueueItem,
} from '../api/orbit';
import { showToast } from '../utils/toast';
import i18n from '../i18n';
import { pushOrbitEvent } from '../utils/orbitDiag';

/**
 * Orbit — host-side tick hook.
 *
 * Mounted once at the app shell level; only does work when the local store
 * says we're the host of an active session. Two independent timers:
 *
 *   - **State tick** (2.5 s): snapshot isPlaying + position + current track
 *     from the player store, patch the local OrbitState, push to the
 *     session playlist's comment.
 *   - **Heartbeat tick** (10 s): refresh the host's own outbox playlist's
 *     comment with a fresh timestamp so the later-added participant
 *     pipeline can treat the host symmetrically.
 *
 * Writes are best-effort — a transient Navidrome outage just means guests
 * see stale state for a tick or two and catch up on the next write.
 * Phase 2 does not yet consume anything from guests.
 */

const STATE_TICK_MS     = 2_500;
const HEARTBEAT_TICK_MS = 10_000;

export function useOrbitHost(): void {
  const role              = useOrbitStore(s => s.role);
  const phase             = useOrbitStore(s => s.phase);
  const sessionPlaylistId = useOrbitStore(s => s.sessionPlaylistId);
  const outboxPlaylistId  = useOrbitStore(s => s.outboxPlaylistId);
  const sessionId         = useOrbitStore(s => s.sessionId);

  // Refs hold the last values we used to build the patch — cheap to
  // recompute against, no need to subscribe to every playerStore tick.
  const lastPushedAtRef = useRef(0);

  const active = role === 'host' && phase === 'active' && !!sessionPlaylistId;

  useEffect(() => {
    if (!active || !sessionPlaylistId) return;

    const snapshotPlayerPatch = (hostUsername: string): Partial<OrbitState> => {
      const p = usePlayerStore.getState();
      const now = Date.now();
      return {
        isPlaying: p.isPlaying,
        positionMs: Math.round((p.currentTime ?? 0) * 1000),
        positionAt: now,
        currentTrack: p.currentTrack
          ? {
              trackId: p.currentTrack.id,
              // Locally-initiated plays are marked as authored by the host.
              // Guest-suggested tracks that later become `currentTrack` will
              // carry their original attribution because the queue-consume
              // flow keeps the `addedBy` from the guest's outbox.
              addedBy: hostUsername,
              addedAt: now,
            }
          : null,
      };
    };

    const pushState = async () => {
      const store = useOrbitStore.getState();
      const base = store.state;
      if (!base) return;

      // 1) Sweep every guest outbox: new suggestions + fresh heartbeats.
      let afterSweep = base;
      try {
        const snaps = await sweepGuestOutboxes(base.sid, base.host);
        afterSweep = applyOutboxSnapshotsToState(base, snaps);
      } catch { /* best-effort; keep old participants and queue */ }

      // 2) Merge newly-suggested items into the host's local play queue so
      //    guest suggestions actually start playing alongside host-chosen
      //    tracks. Must happen BEFORE the shuffle step so the merge decision
      //    tracks `addedAt` (immutable) rather than list position.
      await mergeNewSuggestionsIntoQueue(afterSweep.queue);

      // 3) Shuffle check:
      //    a) `maybeShuffleQueue` handles the OrbitState.queue (guest-facing
      //       suggestion list). It also bumps `lastShuffle` even when the list
      //       is too small to reorder — that's the authoritative 15-min marker.
      //    b) In parallel, we shuffle the *host's* upcoming play queue so the
      //       mix the guests hear actually changes. `autoShuffle=false` skips
      //       both.
      const shouldShuffleNow = afterSweep.settings?.autoShuffle !== false
        && (Date.now() - afterSweep.lastShuffle >= effectiveShuffleIntervalMs(afterSweep));
      const afterShuffle = maybeShuffleQueue(afterSweep);
      if (shouldShuffleNow) {
        const before = usePlayerStore.getState().queue.length;
        usePlayerStore.getState().shuffleUpcomingQueue();
        if (before > 0) showToast(i18n.t('orbit.toastShuffled'), 2500, 'info');
      }

      // 4) Overlay the host's live playback snapshot.
      const playerLive = usePlayerStore.getState();
      const upcoming   = playerLive.queue.slice(playerLive.queueIndex + 1);
      // Map track id → original suggester (if any). State's `queue` carries
      // every suggestion we've ever seen this session, so it's the right
      // attribution source even after the track has been merged into the
      // host's player queue.
      const suggesterByTrack = new Map<string, string>();
      for (const q of afterShuffle.queue) suggesterByTrack.set(q.trackId, q.addedBy);
      const playQueue = upcoming.slice(0, ORBIT_PLAY_QUEUE_LIMIT).map(t => ({
        trackId: t.id,
        addedBy: suggesterByTrack.get(t.id) ?? base.host,
      }));
      const next: OrbitState = {
        ...afterShuffle,
        ...snapshotPlayerPatch(base.host),
        playQueue,
        playQueueTotal: upcoming.length,
      };

      // 5) Commit locally + push remote.
      useOrbitStore.getState().setState(next);
      try {
        await writeOrbitState(sessionPlaylistId, next);
        lastPushedAtRef.current = Date.now();
        pushOrbitEvent('host:push', JSON.stringify({
          track: next.currentTrack?.trackId ?? null,
          playing: next.isPlaying,
          posMs: next.positionMs,
          queueLen: next.playQueueTotal ?? next.playQueue?.length ?? 0,
          guests: next.participants.length,
        }));
      } catch (e) {
        pushOrbitEvent('host:push', `WRITE FAILED: ${String(e)}`);
        /* best-effort; next tick retries */
      }
    };

    /**
     * Resolve each not-yet-merged suggestion via `getSong` and append to the
     * player queue. Records a toast per successful append so the host notices
     * guest activity. Safe to call every tick — the set filter keeps it idempotent.
     */
    const mergeNewSuggestionsIntoQueue = async (items: readonly OrbitQueueItem[]) => {
      // Opt-out: host turned auto-approve off. Items still accumulate in
      // `OrbitState.queue` and show up in the guest view / approval list —
      // they just don't flow into the host's actual play queue yet.
      const store = useOrbitStore.getState();
      const settings = store.state?.settings;
      if (settings && settings.autoApprove === false) return;

      // Host-authored items are enqueued directly by `hostEnqueueToOrbit` and
      // must not flow through the merge pipeline again — otherwise the tick
      // would duplicate the track into the upcoming queue. Declined items
      // stay out too; merged items are the existing dedup anchor.
      const hostUser = store.state?.host;
      const mergedKeys = new Set(store.mergedSuggestionKeys);
      const declinedKeys = new Set(store.declinedSuggestionKeys);
      const pending = items.filter(q =>
        q.addedBy !== hostUser
        && !mergedKeys.has(suggestionKey(q))
        && !declinedKeys.has(suggestionKey(q))
      );
      if (pending.length === 0) return;

      // Resolve in parallel — Navidrome is fine with concurrent getSong calls.
      const resolved = await Promise.all(pending.map(async q => {
        try {
          const song = await getSong(q.trackId);
          return song ? { q, track: songToTrack(song) } : null;
        } catch {
          return null;
        }
      }));

      const toEnqueue = resolved.filter((r): r is { q: OrbitQueueItem; track: ReturnType<typeof songToTrack> } => r !== null);
      const markAllAsMerged = () => pending.forEach(q => store.addMergedSuggestion(suggestionKey(q)));
      if (toEnqueue.length === 0) {
        // Mark the failed lookups as seen anyway so we don't keep retrying
        // every tick for a track the server can't serve.
        markAllAsMerged();
        return;
      }

      // Sprinkle each track at a random spot inside the upcoming range so
      // guest suggestions interleave with host-picked tracks rather than
      // pile up at the end (where they'd never play until the 15-min shuffle).
      const player = usePlayerStore.getState();
      for (const { track } of toEnqueue) {
        const live = usePlayerStore.getState();
        const from = Math.max(0, live.queueIndex + 1);
        const to   = live.queue.length;
        const span = Math.max(1, to - from + 1);
        const pos  = from + Math.floor(Math.random() * span);
        player.enqueueAt([track], pos);
      }
      markAllAsMerged();

      // Friendly nudge per sweep, not per track — bundled toast if >1.
      if (toEnqueue.length === 1) {
        const { q, track } = toEnqueue[0];
        showToast(i18n.t('orbit.toastSuggested', { user: q.addedBy, title: track.title }), 3000, 'info');
      } else {
        showToast(i18n.t('orbit.toastSuggestedMany', { count: toEnqueue.length }), 3000, 'info');
      }
    };

    // Immediate push on mount so guests see fresh state without waiting
    // a full tick after the host comes online.
    void pushState();

    const id = window.setInterval(() => { void pushState(); }, STATE_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, sessionPlaylistId]);

  useEffect(() => {
    if (!active || !outboxPlaylistId || !sessionId) return;
    const server = useOrbitStore.getState().state?.host;
    if (!server) return;
    const outboxName = orbitOutboxPlaylistName(sessionId, server);

    const pushHeartbeat = async () => {
      try { await writeOrbitHeartbeat(outboxPlaylistId, outboxName); }
      catch { /* best-effort */ }
    };
    void pushHeartbeat();

    const id = window.setInterval(() => { void pushHeartbeat(); }, HEARTBEAT_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, outboxPlaylistId, sessionId]);
}
