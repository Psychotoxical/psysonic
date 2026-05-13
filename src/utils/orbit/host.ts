import { createPlaylist, deletePlaylist } from '../../api/subsonicPlaylists';
import { getSong } from '../../api/subsonicLibrary';
import { songToTrack } from '../songToTrack';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { usePlayerStore } from '../../store/playerStore';
import {
  makeInitialOrbitState,
  orbitOutboxPlaylistName,
  orbitSessionPlaylistName,
  ORBIT_DEFAULT_MAX_USERS,
  type OrbitQueueItem,
  type OrbitSettings,
  type OrbitState,
} from '../../api/orbit';
import { generateSessionId } from './helpers';
import { writeOrbitHeartbeat, writeOrbitState } from './remote';

export interface StartOrbitArgs {
  /** Human-readable name the host chose. */
  name: string;
  /** Max participants (defaults to `ORBIT_DEFAULT_MAX_USERS`). */
  maxUsers?: number;
  /**
   * Pre-generated session id. Lets the caller (e.g. the start modal) show a
   * stable share-link *before* the session is actually created. Falls back
   * to a fresh id when omitted.
   */
  sid?: string;
}

/**
 * Host: create a new session.
 *
 * Creates both the canonical session playlist and the host's own outbox,
 * seeds the state blob + heartbeat, binds the store, sets phase to `active`.
 *
 * Throws if the Navidrome server isn't available or lacks a logged-in user.
 * On throw the store is left in the pre-call state — nothing partially bound.
 */
export async function startOrbitSession(args: StartOrbitArgs): Promise<OrbitState> {
  const server = useAuthStore.getState().getActiveServer();
  const username = server?.username;
  if (!username) throw new Error('No active Navidrome server / user');

  const store = useOrbitStore.getState();
  if (store.phase !== 'idle') {
    throw new Error(`Cannot start while phase is ${store.phase}`);
  }

  store.setPhase('starting');

  let sessionPlaylistId: string | null = null;
  let outboxPlaylistId:  string | null = null;
  try {
    const sid = args.sid ?? generateSessionId();
    const sessionName = orbitSessionPlaylistName(sid);
    const outboxName  = orbitOutboxPlaylistName(sid, username);

    // Create both playlists. Navidrome's createPlaylist returns the created
    // object with its new id.
    const sessionPlaylist = await createPlaylist(sessionName);
    sessionPlaylistId = sessionPlaylist.id;

    const outboxPlaylist = await createPlaylist(outboxName);
    outboxPlaylistId = outboxPlaylist.id;

    // Seed state blob + heartbeat. We use updatePlaylistMeta instead of
    // separate create-with-comment because Subsonic's createPlaylist doesn't
    // take a comment argument.
    const state = makeInitialOrbitState({
      sid,
      host: username,
      name: args.name,
      maxUsers: args.maxUsers ?? ORBIT_DEFAULT_MAX_USERS,
    });
    await writeOrbitState(sessionPlaylistId, state);
    await writeOrbitHeartbeat(outboxPlaylistId, outboxName);

    // Bind local store — session is now live.
    useOrbitStore.setState({
      role: 'host',
      sessionId: sid,
      sessionPlaylistId,
      outboxPlaylistId,
      phase: 'active',
      state,
      errorMessage: null,
      joinedAt: Date.now(),
    });

    return state;
  } catch (err) {
    // Best-effort cleanup of anything we managed to create before the failure.
    if (outboxPlaylistId)  { try { await deletePlaylist(outboxPlaylistId); }  catch { /* ignore */ } }
    if (sessionPlaylistId) { try { await deletePlaylist(sessionPlaylistId); } catch { /* ignore */ } }
    useOrbitStore.getState().setPhase('idle');
    throw err;
  }
}

/**
 * Host: end the session cleanly.
 *
 * Writes `ended: true` first so any poll-in-progress from a guest sees the
 * signal, then deletes both playlists and resets the local store. Each step
 * is best-effort; if something's already gone server-side we still zero out
 * local state so the UI returns to idle.
 */
export async function endOrbitSession(): Promise<void> {
  const { role, state, sessionPlaylistId, outboxPlaylistId } = useOrbitStore.getState();
  if (role !== 'host') return;

  // 1) Flip `ended` so guests notice on their next poll even if deletion fails.
  if (sessionPlaylistId && state) {
    try {
      await writeOrbitState(sessionPlaylistId, { ...state, ended: true });
    } catch { /* best-effort */ }
  }

  // 2) Delete both playlists. Order: outbox first — if session delete fails,
  // a stale session playlist with ended=true is fine; a stale outbox without
  // a session is noise.
  if (outboxPlaylistId)  { try { await deletePlaylist(outboxPlaylistId); }  catch { /* best-effort */ } }
  if (sessionPlaylistId) { try { await deletePlaylist(sessionPlaylistId); } catch { /* best-effort */ } }

  // 3) Local teardown.
  useOrbitStore.getState().reset();
}

/**
 * Host-only: force an immediate shuffle of the upcoming play queue, bump
 * `lastShuffle` so the automatic 15-min timer resets, and push the new
 * state to Navidrome. Ignores the `autoShuffle` setting — this is an
 * explicit user action.
 */
export async function triggerOrbitShuffleNow(): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host' || !store.state || !store.sessionPlaylistId) return;

  // 1) Shuffle the host's real play queue (upcoming only).
  usePlayerStore.getState().shuffleUpcomingQueue();

  // 2) Shuffle the OrbitState.queue (guest-facing suggestion history) +
  //    bump lastShuffle so the auto-shuffle timer restarts.
  const now = Date.now();
  const shuffled = store.state.queue.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const next: OrbitState = { ...store.state, queue: shuffled, lastShuffle: now };
  store.setState(next);
  try { await writeOrbitState(store.sessionPlaylistId, next); }
  catch { /* best-effort; next host-tick will push */ }
}

/**
 * Host-only: update the session settings and immediately push to Navidrome
 * so guests see the change on their next poll. No-op unless the caller is
 * the current host with an active session.
 */
export async function updateOrbitSettings(patch: Partial<OrbitSettings>): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host' || !store.state || !store.sessionPlaylistId) return;
  const mergedSettings: OrbitSettings = {
    ...(store.state.settings ?? { autoApprove: true, autoShuffle: true }),
    ...patch,
  };
  const next: OrbitState = { ...store.state, settings: mergedSettings };
  store.setState(next);
  try { await writeOrbitState(store.sessionPlaylistId, next); }
  catch { /* best-effort; next host-tick will push the current state anyway */ }
}

/**
 * Host: add a track to the active Orbit session directly, skipping the
 * outbox/approval loop guests go through. The track lands in the host's
 * own play queue immediately and is attributed to the host in the
 * session's suggestion history. Host-authored queue items are filtered
 * out of the tick-merge pipeline so the host-tick doesn't re-insert the
 * same track once it notices the new entry in `OrbitState.queue`.
 */
export async function hostEnqueueToOrbit(trackId: string): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host' || !store.state || !store.sessionPlaylistId) {
    throw new Error('Not hosting an active Orbit session');
  }

  const song = await getSong(trackId);
  if (!song) throw new Error('Track not found');
  const track = songToTrack(song);

  usePlayerStore.getState().enqueue([track]);

  const item: OrbitQueueItem = { trackId, addedBy: store.state.host, addedAt: Date.now() };
  const next: OrbitState = { ...store.state, queue: [...store.state.queue, item] };
  store.setState(next);
  try { await writeOrbitState(store.sessionPlaylistId, next); }
  catch { /* best-effort; next host-tick will push the merged state anyway */ }
}
