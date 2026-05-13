import { createPlaylist, deletePlaylist, getPlaylist, getPlaylists, updatePlaylist } from '../../api/subsonicPlaylists';
import { getSong } from '../../api/subsonicLibrary';
import { songToTrack } from '../songToTrack';
import { useAuthStore } from '../../store/authStore';
import { useOrbitStore } from '../../store/orbitStore';
import { usePlayerStore } from '../../store/playerStore';
import {
  orbitOutboxPlaylistName,
  type OrbitQueueItem,
  type OrbitState,
} from '../../api/orbit';
import { suggestionKey } from './helpers';
import { findSessionPlaylistId, readOrbitState, writeOrbitHeartbeat } from './remote';

export class OrbitJoinError extends Error {
  constructor(
    public readonly reason: 'not-found' | 'ended' | 'full' | 'kicked' | 'no-user' | 'server-error',
    message: string,
  ) {
    super(message);
    this.name = 'OrbitJoinError';
  }
}

/**
 * Guest: join an existing session by id.
 *
 * Assumes the user is already authenticated against the correct Navidrome
 * server — the caller's UI layer handles the magic-sharing flow when the
 * encoded server in the share link doesn't match the active one.
 *
 * Side effects on success:
 *   - creates this user's outbox playlist and writes a first heartbeat
 *   - binds `useOrbitStore` to the session (role = guest, phase = active)
 *   - populates the store's `state` mirror with the last-known blob
 *
 * Throws `OrbitJoinError` on any gate failure; caller shows an error
 * modal and does nothing else.
 */
export async function joinOrbitSession(sid: string): Promise<OrbitState> {
  const server = useAuthStore.getState().getActiveServer();
  const username = server?.username;
  if (!username) throw new OrbitJoinError('no-user', 'No active Navidrome server / user');

  const store = useOrbitStore.getState();
  if (store.phase !== 'idle') {
    throw new OrbitJoinError('server-error', `Cannot join while phase is ${store.phase}`);
  }

  store.setPhase('joining');

  let outboxPlaylistId: string | null = null;
  try {
    // 1) Locate the session playlist and read its state blob.
    const sessionPlaylistId = await findSessionPlaylistId(sid);
    if (!sessionPlaylistId) throw new OrbitJoinError('not-found', `Session ${sid} not found on server`);

    const state = await readOrbitState(sessionPlaylistId);
    if (!state)         throw new OrbitJoinError('not-found', `Session ${sid} has no valid state`);
    if (state.ended)    throw new OrbitJoinError('ended',     `Session ${sid} has ended`);

    // 2) Gate: not kicked, not full. Note: host isn't in `participants` itself,
    //    so `maxUsers` counts guests only.
    if (state.kicked.includes(username)) {
      throw new OrbitJoinError('kicked', `You were removed from session ${sid}`);
    }
    const alreadyInside = state.participants.some(p => p.user === username);
    if (!alreadyInside && state.participants.length >= state.maxUsers) {
      throw new OrbitJoinError('full', `Session ${sid} is full (${state.maxUsers}/${state.maxUsers})`);
    }

    // 3) Create our outbox + first heartbeat.
    const outboxName = orbitOutboxPlaylistName(sid, username);
    // Guard against a stale outbox from a previous abandoned join attempt —
    // if one exists under the same name, reuse its id instead of creating
    // a duplicate (Navidrome allows duplicate names but it'd leak).
    const existing = (await getPlaylists(true).catch(() => [])).find(p => p.name === outboxName);
    if (existing) {
      outboxPlaylistId = existing.id;
    } else {
      const outbox = await createPlaylist(outboxName);
      outboxPlaylistId = outbox.id;
    }
    await writeOrbitHeartbeat(outboxPlaylistId, outboxName);

    // 4) Bind the local store. The host's next poll will register us in
    //    `participants` — we don't self-mutate the canonical state.
    useOrbitStore.setState({
      role: 'guest',
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
    // Best-effort cleanup.
    if (outboxPlaylistId) { try { await deletePlaylist(outboxPlaylistId); } catch { /* ignore */ } }
    useOrbitStore.getState().setPhase('idle');
    throw err;
  }
}

/**
 * Guest: leave a session voluntarily.
 *
 * Deletes our outbox (so the host stops counting us after its next sweep)
 * and resets the local store. Best-effort on each step. Does NOT touch the
 * canonical session playlist — that's the host's property.
 */
export async function leaveOrbitSession(): Promise<void> {
  const { role, outboxPlaylistId } = useOrbitStore.getState();
  if (role !== 'guest') return;

  if (outboxPlaylistId) {
    try { await deletePlaylist(outboxPlaylistId); } catch { /* best-effort */ }
  }

  useOrbitStore.getState().reset();
}

/** Why a guest's suggestion would be blocked, in priority order. `null` means
 *  the suggestion can proceed. */
export type OrbitSuggestGateReason = 'not-guest' | 'muted' | null;

/**
 * Evaluate whether the local guest is allowed to send a new suggestion right
 * now — used by both the UI (to disable buttons / show toasts) and
 * {@link suggestOrbitTrack} as a defensive check.
 */
export function evaluateOrbitSuggestGate(): { allowed: boolean; reason: OrbitSuggestGateReason } {
  const { role, state } = useOrbitStore.getState();
  if (role !== 'guest' || !state) return { allowed: false, reason: 'not-guest' };
  const username = useAuthStore.getState().getActiveServer()?.username ?? '';
  if (state.suggestionBlocked?.includes(username)) {
    return { allowed: false, reason: 'muted' };
  }
  return { allowed: true, reason: null };
}

export class OrbitSuggestBlockedError extends Error {
  constructor(public readonly reason: Exclude<OrbitSuggestGateReason, null>) {
    super(`Suggestion blocked: ${reason}`);
    this.name = 'OrbitSuggestBlockedError';
  }
}

/**
 * Guest: suggest a track to the session.
 *
 * Appends the track to our own outbox playlist. The host's next sweep will
 * consume it and publish the authoritative queue update in the state blob.
 * No state mutation here — the guest never touches canonical state.
 */
export async function suggestOrbitTrack(trackId: string): Promise<void> {
  const gate = evaluateOrbitSuggestGate();
  if (!gate.allowed && gate.reason && gate.reason !== 'not-guest') {
    throw new OrbitSuggestBlockedError(gate.reason);
  }
  const { role, outboxPlaylistId, sessionId } = useOrbitStore.getState();
  if (role !== 'guest') throw new Error('Not joined to a session as a guest');
  if (!outboxPlaylistId || !sessionId) throw new Error('No outbox bound');

  // Read current outbox contents and append — createPlaylist.view with
  // playlistId replaces songs wholesale, so we need to carry the existing
  // list along.
  const { songs } = await getPlaylist(outboxPlaylistId);
  const nextIds = [...songs.map(s => s.id), trackId];
  await updatePlaylist(outboxPlaylistId, nextIds, songs.length);

  // Record the suggestion locally so the UI can surface it as "waiting on
  // host" until the host's next sweep merges it into the shared queue.
  // Drained by the guest tick's reconcilePendingSuggestions call.
  useOrbitStore.getState().addPendingSuggestion(trackId);
}

/**
 * Host: accept a guest suggestion and route it into the live play queue.
 * No-op outside host role. Uses the shared `mergedSuggestionKeys` store
 * slot so the tick doesn't re-process the same item.
 */
export async function approveOrbitSuggestion(q: OrbitQueueItem): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host' || !store.state) return;
  try {
    const song = await getSong(q.trackId);
    if (!song) return;
    const track = songToTrack(song);
    usePlayerStore.getState().enqueue([track]);
    store.addMergedSuggestion(suggestionKey(q));
  } catch { /* silent */ }
}

/**
 * Host: reject a guest suggestion. It stays in `OrbitState.queue` as
 * history but is filtered out of the approval UI and the merge tick.
 */
export function declineOrbitSuggestion(q: OrbitQueueItem): void {
  const store = useOrbitStore.getState();
  if (store.role !== 'host') return;
  store.addDeclinedSuggestion(suggestionKey(q));
}
