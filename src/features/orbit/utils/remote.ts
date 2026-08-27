import { getPlaylistForServer, getPlaylistsForServer, updatePlaylistMeta } from '@/lib/api/subsonicPlaylists';
import {
  orbitSessionPlaylistName,
  parseOrbitState,
  type OrbitOutboxMeta,
  type OrbitState,
} from '@/features/orbit/api/orbit';
import { serialiseOrbitStateForWire, serialiseOutboxMeta } from '@/features/orbit/utils/helpers';
import { normalizeNavidromeExternalId } from '@/lib/server/navidromeCanonicalExternalId';

function normalizeOrbitStateIds(state: OrbitState, serverId: string): OrbitState {
  const normalizeItem = <T extends { trackId: string }>(item: T): T => ({
    ...item,
    trackId: normalizeNavidromeExternalId(serverId, item.trackId),
  });
  return {
    ...state,
    currentTrack: state.currentTrack ? normalizeItem(state.currentTrack) : null,
    queue: state.queue.map(normalizeItem),
    playQueue: state.playQueue?.map(normalizeItem),
  };
}

/** Pull + parse the canonical state from the session playlist. Null on miss or parse error. */
export async function readOrbitState(sessionPlaylistId: string, serverId: string): Promise<OrbitState | null> {
  try {
    const { playlist } = await getPlaylistForServer(serverId, sessionPlaylistId);
    if (!playlist.comment) return null;
    let raw: unknown;
    try { raw = JSON.parse(playlist.comment); } catch { return null; }
    const state = parseOrbitState(raw);
    return state ? normalizeOrbitStateIds(state, serverId) : null;
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
  serverId: string,
): Promise<void> {
  const comment = serialiseOrbitStateForWire(state);
  const name = orbitSessionPlaylistName(state.sid);
  await updatePlaylistMeta(sessionPlaylistId, name, comment, /* public */ true, serverId);
}

/**
 * Write a heartbeat into the given outbox playlist's comment. Host keeps one
 * for symmetry + to feed its own presence into the participants pipeline
 * (used from Phase 4 onwards when guests look for host liveness).
 */
export async function writeOrbitHeartbeat(
  outboxPlaylistId: string,
  outboxName: string,
  serverId: string,
): Promise<void> {
  const meta: OrbitOutboxMeta = { ts: Date.now() };
  await updatePlaylistMeta(outboxPlaylistId, outboxName, serialiseOutboxMeta(meta), /* public */ true, serverId);
}

/**
 * Find the Navidrome playlist id of a session given its session id.
 * Scans the user's visible playlist list — Navidrome exposes public
 * playlists from other users, so a guest can find the host's session.
 */
export async function findSessionPlaylistId(sid: string, serverId: string): Promise<string | null> {
  const target = orbitSessionPlaylistName(sid);
  try {
    const all = await getPlaylistsForServer(serverId, true);
    const hit = all.find(p => p.name === target);
    return hit?.id ?? null;
  } catch { return null; }
}
