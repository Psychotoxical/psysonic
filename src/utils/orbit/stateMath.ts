import { useOrbitStore } from '../../store/orbitStore';
import type {
  OrbitParticipant,
  OrbitQueueItem,
  OrbitState,
} from '../../api/orbit';
import {
  ORBIT_HEARTBEAT_ALIVE_MS,
  ORBIT_REMOVED_TTL_MS,
  ORBIT_SHUFFLE_INTERVAL_MS,
} from './constants';

/** Merge a patch into the store's state blob, keeping nullability. */
export function patchOrbitState(patch: Partial<OrbitState>): OrbitState | null {
  const current = useOrbitStore.getState().state;
  if (!current) return null;
  const next: OrbitState = { ...current, ...patch };
  useOrbitStore.getState().setState(next);
  return next;
}

/**
 * Resolve the active auto-shuffle cadence in ms. Reads the host's configured
 * preset from `state.settings.shuffleIntervalMin`; older sessions that lack
 * the field fall back to 15 min so their tick cadence is unchanged.
 */
export function effectiveShuffleIntervalMs(state: Pick<OrbitState, 'settings'>): number {
  const min = state.settings?.shuffleIntervalMin;
  return typeof min === 'number' ? min * 60_000 : ORBIT_SHUFFLE_INTERVAL_MS;
}

/**
 * Host helper — applies a Fisher-Yates shuffle to `state.queue` iff enough
 * time has passed since the last shuffle. Pure, returns a new state object.
 * `currentTrack` is never touched.
 */
export function maybeShuffleQueue(state: OrbitState, nowMs: number = Date.now()): OrbitState {
  if (state.settings?.autoShuffle === false) return state;
  if (nowMs - state.lastShuffle < effectiveShuffleIntervalMs(state)) return state;
  if (state.queue.length < 2) {
    // Still bump `lastShuffle` so the next eligible shuffle is one full
    // interval away, preventing a tight retry loop right after a guest
    // drops a single item in.
    return { ...state, lastShuffle: nowMs };
  }
  const shuffled = state.queue.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { ...state, queue: shuffled, lastShuffle: nowMs };
}

/** Drift between a guest's local playback and the host's estimated live position. */
export function computeOrbitDriftMs(state: OrbitState, guestPositionMs: number, nowMs: number = Date.now()): number {
  const hostEstimated = state.positionMs + (state.isPlaying ? (nowMs - state.positionAt) : 0);
  return guestPositionMs - hostEstimated;
}

export interface OutboxSnapshot {
  user: string;
  outboxPlaylistId: string;
  /** Track IDs currently sitting in the outbox — these are the new suggestions. */
  trackIds: string[];
  /** Last heartbeat timestamp parsed from the outbox comment, or 0 if missing/broken. */
  lastHeartbeat: number;
}

/**
 * Fold sweep results into an updated `OrbitState`.
 *
 *   - New queue items are appended to `state.queue`, with `addedBy` = user
 *     and `addedAt` = now. Host-authored tracks (host's own currentTrack
 *     progression) are handled elsewhere and don't flow through this path.
 *   - `participants` is rebuilt from scratch from the sweep heartbeats —
 *     anyone with a fresh heartbeat (< `ORBIT_HEARTBEAT_ALIVE_MS` old) and
 *     not in `kicked` counts as alive. Users that disappear from the sweep
 *     age out naturally.
 */
export function applyOutboxSnapshotsToState(
  state: OrbitState,
  snapshots: OutboxSnapshot[],
  nowMs: number = Date.now(),
): OrbitState {
  // ── Queue additions ──
  // Guest outboxes are append-only from the host's POV — the host reads the
  // same playlist every sweep, so we must dedupe against anything already in
  // `state.queue` (or currently playing) by (user, trackId). Without this,
  // every host tick re-adds every outbox entry and the pending-approval list
  // balloons indefinitely. A user re-suggesting the same track after it
  // lands/plays is a rare enough case to live with for now.
  const existingKeys = new Set<string>(
    state.queue.map(q => `${q.addedBy} ${q.trackId}`),
  );
  if (state.currentTrack) {
    existingKeys.add(`${state.currentTrack.addedBy} ${state.currentTrack.trackId}`);
  }

  // Drop any new suggestion from a user the host has muted before the
  // dedupe scan — they shouldn't count against the queue at all.
  const blocked = new Set(state.suggestionBlocked ?? []);
  const newItems: OrbitQueueItem[] = [];
  for (const snap of snapshots) {
    if (blocked.has(snap.user)) continue;
    for (const trackId of snap.trackIds) {
      const key = `${snap.user} ${trackId}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      newItems.push({ trackId, addedBy: snap.user, addedAt: nowMs });
    }
  }

  // ── Soft-removed list aging ──
  // Drop entries older than the TTL so the list stays bounded and a long-
  // expired marker doesn't kick a freshly-rejoined user back out.
  const removed = (state.removed ?? []).filter(r => nowMs - r.at < ORBIT_REMOVED_TTL_MS);
  const removedUsers = new Set(removed.map(r => r.user));

  // ── Participants rebuild ──
  // Soft-removed users stay out of `participants` even if their heartbeat is
  // still fresh — gives them up to one read tick (~2.5s) to notice the
  // `removed`-marker and tear down their guest hooks before the marker ages out.
  const prev = new Map(state.participants.map(p => [p.user, p]));
  const participants: OrbitParticipant[] = [];
  for (const snap of snapshots) {
    if (state.kicked.includes(snap.user)) continue;
    if (removedUsers.has(snap.user)) continue;
    const fresh = snap.lastHeartbeat > 0 && (nowMs - snap.lastHeartbeat) < ORBIT_HEARTBEAT_ALIVE_MS;
    if (!fresh) continue;
    const existing = prev.get(snap.user);
    participants.push({
      user: snap.user,
      joinedAt: existing?.joinedAt ?? nowMs,
      lastHeartbeat: snap.lastHeartbeat,
    });
  }

  return {
    ...state,
    queue: newItems.length > 0 ? [...state.queue, ...newItems] : state.queue,
    participants,
    removed,
  };
}
