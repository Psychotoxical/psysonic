import { deletePlaylist, getPlaylists } from '../../api/subsonicPlaylists';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { ORBIT_PLAYLIST_PREFIX, parseOrbitState } from '../../api/orbit';
import { ORBIT_ORPHAN_TTL_MS } from './constants';

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
