import { getPlaylist, getPlaylists, updatePlaylist } from '../../api/subsonicPlaylists';
import { type OrbitOutboxMeta } from '../../api/orbit';
import { parseOutboxPlaylistName } from './helpers';
import { type OutboxSnapshot } from './stateMath';

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
