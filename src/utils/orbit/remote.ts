import { getPlaylist, getPlaylists, updatePlaylistMeta } from '../../api/subsonicPlaylists';
import {
  orbitSessionPlaylistName,
  parseOrbitState,
  type OrbitOutboxMeta,
  type OrbitState,
} from '../../api/orbit';
import { serialiseOrbitState, serialiseOutboxMeta } from './helpers';

/** Pull + parse the canonical state from the session playlist. Null on miss or parse error. */
export async function readOrbitState(sessionPlaylistId: string): Promise<OrbitState | null> {
  try {
    const { playlist } = await getPlaylist(sessionPlaylistId);
    if (!playlist.comment) return null;
    let raw: unknown;
    try { raw = JSON.parse(playlist.comment); } catch { return null; }
    return parseOrbitState(raw);
  } catch { return null; }
}

/**
 * Write the state blob into the session playlist's comment.
 *
 * NOTE (design doc "known rough edges"): `updatePlaylist.view` with name +
 * comment MUST preserve the track list. Confirmed to work on Navidrome via
 * observation in PR #256 (playlist-editor); if a future Navidrome release
 * ever changes that, we need to switch to `updatePlaylist` with the full
 * track list echoed back.
 */
export async function writeOrbitState(
  sessionPlaylistId: string,
  state: OrbitState,
): Promise<void> {
  const comment = serialiseOrbitState(state);
  const name = orbitSessionPlaylistName(state.sid);
  await updatePlaylistMeta(sessionPlaylistId, name, comment, /* public */ true);
}

/**
 * Write a heartbeat into the given outbox playlist's comment. Host keeps one
 * for symmetry + to feed its own presence into the participants pipeline
 * (used from Phase 4 onwards when guests look for host liveness).
 */
export async function writeOrbitHeartbeat(
  outboxPlaylistId: string,
  outboxName: string,
): Promise<void> {
  const meta: OrbitOutboxMeta = { ts: Date.now() };
  await updatePlaylistMeta(outboxPlaylistId, outboxName, serialiseOutboxMeta(meta), /* public */ true);
}

/**
 * Find the Navidrome playlist id of a session given its session id.
 * Scans the user's visible playlist list — Navidrome exposes public
 * playlists from other users, so a guest can find the host's session.
 */
export async function findSessionPlaylistId(sid: string): Promise<string | null> {
  const target = orbitSessionPlaylistName(sid);
  try {
    const all = await getPlaylists(true);
    const hit = all.find(p => p.name === target);
    return hit?.id ?? null;
  } catch { return null; }
}
