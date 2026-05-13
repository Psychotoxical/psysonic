import { createPlaylist, updatePlaylist, deletePlaylist, getPlaylist, getPlaylists } from '../api/subsonicPlaylists';
import { getSong } from '../api/subsonicLibrary';
import { songToTrack } from '../utils/songToTrack';
import { useAuthStore } from '../store/authStore';
import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import {
  orbitOutboxPlaylistName,
  parseOrbitState,
  ORBIT_PLAYLIST_PREFIX,
  type OrbitOutboxMeta,
  type OrbitQueueItem,
  type OrbitState,
} from '../api/orbit';
import { ORBIT_ORPHAN_TTL_MS } from './orbit/constants';
import {
  generateSessionId,
  parseOutboxPlaylistName,
  suggestionKey,
} from './orbit/helpers';
import {
  applyOutboxSnapshotsToState,
  type OutboxSnapshot,
} from './orbit/stateMath';
import {
  findSessionPlaylistId,
  readOrbitState,
  writeOrbitHeartbeat,
  writeOrbitState,
} from './orbit/remote';

/**
 * Orbit — host-side lifecycle primitives.
 *
 * Phase 2 scope: creating / ending a session, serialising state into the
 * canonical playlist comment, writing a heartbeat into the host's own
 * outbox. No guest-side logic here.
 *
 * All functions talk to Navidrome through the existing Subsonic wrappers;
 * no new transport work.
 */

// ── Re-exports from split modules ─────────────────────────────────────
export {
  ORBIT_HEARTBEAT_ALIVE_MS,
  ORBIT_ORPHAN_TTL_MS,
  ORBIT_REMOVED_TTL_MS,
  ORBIT_SHUFFLE_INTERVAL_MS,
} from './orbit/constants';
export {
  generateSessionId,
  OrbitStateTooLarge,
  serialiseOrbitState,
  suggestionKey,
} from './orbit/helpers';
export {
  applyOutboxSnapshotsToState,
  computeOrbitDriftMs,
  effectiveShuffleIntervalMs,
  maybeShuffleQueue,
  patchOrbitState,
} from './orbit/stateMath';
export {
  findSessionPlaylistId,
  readOrbitState,
  writeOrbitHeartbeat,
  writeOrbitState,
} from './orbit/remote';
export {
  buildOrbitShareLink,
  parseOrbitShareLink,
  type OrbitShareLink,
} from './orbit/shareLink';
export {
  endOrbitSession,
  hostEnqueueToOrbit,
  startOrbitSession,
  triggerOrbitShuffleNow,
  updateOrbitSettings,
  type StartOrbitArgs,
} from './orbit/host';
export {
  kickOrbitParticipant,
  removeOrbitParticipant,
  setOrbitSuggestionBlocked,
} from './orbit/moderation';
export {
  approveOrbitSuggestion,
  declineOrbitSuggestion,
  evaluateOrbitSuggestGate,
  joinOrbitSession,
  leaveOrbitSession,
  OrbitJoinError,
  OrbitSuggestBlockedError,
  suggestOrbitTrack,
  type OrbitSuggestGateReason,
} from './orbit/guest';


/**
 * Host: add a track to the active Orbit session directly, skipping the
 * outbox/approval loop guests go through. The track lands in the host's
 * own play queue immediately and is attributed to the host in the
 * session's suggestion history. Host-authored queue items are filtered
 * out of the tick-merge pipeline so the host-tick doesn't re-insert the
 * same track once it notices the new entry in `OrbitState.queue`.
 */
/**
 * App-start sweep: delete our own __psyorbit_* playlists that no longer
 * belong to a live session. "Live" means either this device's current
 * session (never touch) or one whose heartbeat is less than
 * `ORBIT_ORPHAN_TTL_MS` old (could be a session on another device of
 * ours). Anything older — including unparseable / comment-less entries —
 * is a leftover from a crash / force-close / network blip and gets
 * removed so it doesn't clutter the Navidrome playlist view.
 *
 * Runs best-effort; individual failures are swallowed. Returns the count
 * of playlists actually deleted, for logging.
 */
export async function cleanupOrphanedOrbitPlaylists(): Promise<number> {
  const username = useAuthStore.getState().getActiveServer()?.username;
  if (!username) return 0;

  const all = await getPlaylists(true).catch(() => [] as Awaited<ReturnType<typeof getPlaylists>>);
  const now = Date.now();
  const TTL = ORBIT_ORPHAN_TTL_MS;
  const currentSid = useOrbitStore.getState().sessionId;

  const nameRe = new RegExp(`^${ORBIT_PLAYLIST_PREFIX}([a-f0-9]+)(_from_.+__)?$`);
  let deleted = 0;

  for (const p of all) {
    if (!p.name.startsWith(ORBIT_PLAYLIST_PREFIX)) continue;
    // Only touch our own — Navidrome rejects deletes on foreign playlists anyway.
    if (p.owner && p.owner !== username) continue;

    const match = p.name.match(nameRe);
    // Not one we recognise — assume corrupt, prune.
    if (!match) {
      try { await deletePlaylist(p.id); deleted++; } catch { /* best-effort */ }
      continue;
    }
    const sid = match[1];
    const isOutbox = !!match[2];
    if (sid === currentSid) continue;

    let timestamp = 0;
    let ended = false;
    if (p.comment) {
      try {
        const parsed = JSON.parse(p.comment);
        if (isOutbox) {
          if (parsed && typeof parsed.ts === 'number') timestamp = parsed.ts;
        } else {
          const state = parseOrbitState(parsed);
          if (state) {
            timestamp = state.positionAt ?? 0;
            ended = state.ended === true;
          }
        }
      } catch { /* unparseable → treat as dead */ }
    }

    // Fall back to Navidrome's `changed` timestamp when there's no
    // orbit-authored heartbeat in the comment — saves us from deleting a
    // playlist that was just created seconds ago.
    if (timestamp === 0 && p.changed) {
      const parsed = Date.parse(p.changed);
      if (!isNaN(parsed)) timestamp = parsed;
    }

    const stale = timestamp === 0 || (now - timestamp > TTL);
    if (ended || stale) {
      try { await deletePlaylist(p.id); deleted++; } catch { /* best-effort */ }
    }
  }
  return deleted;
}

// ── Host-side outbox sweep ──────────────────────────────────────────────

/**
 * Host: list all guest outbox playlists for the current session.
 * Skips the host's own outbox — that's heartbeat-only, not a suggestion channel.
 */
async function listGuestOutboxes(sid: string, hostUsername: string): Promise<Array<{ id: string; name: string; user: string }>> {
  const all = await getPlaylists(true).catch(() => []);
  const result: Array<{ id: string; name: string; user: string }> = [];
  for (const p of all) {
    const user = parseOutboxPlaylistName(p.name, sid);
    if (!user || user === hostUsername) continue;
    result.push({ id: p.id, name: p.name, user });
  }
  return result;
}

/**
 * Host: read one outbox's contents (suggested tracks + heartbeat ts).
 */
async function readOutbox(playlistId: string): Promise<{ trackIds: string[]; lastHeartbeat: number }> {
  try {
    const { playlist, songs } = await getPlaylist(playlistId);
    let ts = 0;
    if (playlist.comment) {
      try {
        const meta = JSON.parse(playlist.comment) as Partial<OrbitOutboxMeta>;
        if (typeof meta.ts === 'number') ts = meta.ts;
      } catch { /* malformed — treat as no heartbeat */ }
    }
    return { trackIds: songs.map(s => s.id), lastHeartbeat: ts };
  } catch {
    return { trackIds: [], lastHeartbeat: 0 };
  }
}

/**
 * Host: sweep every guest outbox once.
 *
 *   - Collects suggested track IDs from each outbox (returns them so the
 *     caller can wire them into the state queue with `addedBy` = user).
 *   - Captures the latest heartbeat ts per user for the participants list.
 *   - Clears the outbox track list after reading — a single-pass consume
 *     semantic: once the host has seen a track, the guest doesn't need to
 *     show it as "pending" any longer. The outbox's heartbeat comment is
 *     left untouched because the guest's own heartbeat hook keeps refreshing it.
 *
 * Returns a list of snapshots, one per live guest outbox. Errors on
 * individual outboxes are swallowed — best-effort.
 */
export async function sweepGuestOutboxes(sid: string, hostUsername: string): Promise<OutboxSnapshot[]> {
  const outboxes = await listGuestOutboxes(sid, hostUsername);
  const snaps: OutboxSnapshot[] = [];
  for (const ob of outboxes) {
    const { trackIds, lastHeartbeat } = await readOutbox(ob.id);
    snaps.push({ user: ob.user, outboxPlaylistId: ob.id, trackIds, lastHeartbeat });
    if (trackIds.length > 0) {
      // Clear the outbox tracks. Leaves the heartbeat comment untouched.
      try { await updatePlaylist(ob.id, [], trackIds.length); } catch { /* best-effort */ }
    }
  }
  return snaps;
}


