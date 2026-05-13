import { deletePlaylist, getPlaylists } from '../../api/subsonicPlaylists';
import { useOrbitStore } from '../../store/orbitStore';
import { orbitOutboxPlaylistName, type OrbitState } from '../../api/orbit';
import { writeOrbitState } from './remote';

/**
 * Host: kick a participant by username.
 *
 * Appends the user to `kicked`, removes them from `participants`, deletes
 * their outbox playlist (so a fresh re-create is recognised as a fresh
 * attempt the gate blocks), and writes the new state immediately so the
 * kicked guest notices on their very next poll rather than waiting for
 * the regular sweep tick.
 *
 * Ignored if not the host, or if the session isn't active.
 */
export async function kickOrbitParticipant(username: string): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host') return;
  const state = store.state;
  const sessionPlaylistId = store.sessionPlaylistId;
  const sid = store.sessionId;
  if (!state || !sessionPlaylistId || !sid) return;
  if (username === state.host) return;         // host can't self-kick
  if (state.kicked.includes(username)) return; // already kicked

  // 1) Delete the victim's outbox, best-effort. Finding it by name avoids
  // carrying outbox ids in the state blob just for this operation.
  const outboxName = orbitOutboxPlaylistName(sid, username);
  try {
    const all = await getPlaylists(true);
    const hit = all.find(p => p.name === outboxName);
    if (hit) await deletePlaylist(hit.id);
  } catch { /* best-effort */ }

  // 2) Update state: append kick, drop from participants. Also strip any
  // pending soft-`removed` marker for the same user — the permanent ban
  // supersedes it.
  const nextState: OrbitState = {
    ...state,
    kicked: [...state.kicked, username],
    participants: state.participants.filter(p => p.user !== username),
    removed: (state.removed ?? []).filter(r => r.user !== username),
  };
  useOrbitStore.getState().setState(nextState);
  try {
    await writeOrbitState(sessionPlaylistId, nextState);
  } catch { /* best-effort; next host tick will retry via its normal push */ }
}

/**
 * Host: soft-remove a participant by username.
 *
 * Like `kickOrbitParticipant`, but does NOT add the user to `kicked` —
 * instead writes a short-lived entry to `removed`. The affected guest sees
 * it on their next state-read tick and is shown a "you were removed" exit
 * modal, but they are free to re-join immediately via the invite link.
 *
 * The marker ages out after `ORBIT_REMOVED_TTL_MS` in `applyOutboxSnapshotsToState`.
 *
 * Ignored if not the host, target is the host, target is permanently
 * kicked, or the session isn't active.
 */
export async function removeOrbitParticipant(username: string): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host') return;
  const state = store.state;
  const sessionPlaylistId = store.sessionPlaylistId;
  const sid = store.sessionId;
  if (!state || !sessionPlaylistId || !sid) return;
  if (username === state.host) return;
  if (state.kicked.includes(username)) return;

  // 1) Delete outbox so the guest's next heartbeat-write hits a missing
  // playlist (they'll create a new one on rejoin via joinOrbitSession).
  const outboxName = orbitOutboxPlaylistName(sid, username);
  try {
    const all = await getPlaylists(true);
    const hit = all.find(p => p.name === outboxName);
    if (hit) await deletePlaylist(hit.id);
  } catch { /* best-effort */ }

  // 2) Update state: drop from participants, append fresh `removed` marker.
  // Filter any prior marker for the same user so we always carry the latest ts.
  const now = Date.now();
  const nextState: OrbitState = {
    ...state,
    participants: state.participants.filter(p => p.user !== username),
    removed: [
      ...(state.removed ?? []).filter(r => r.user !== username),
      { user: username, at: now },
    ],
  };
  useOrbitStore.getState().setState(nextState);
  try {
    await writeOrbitState(sessionPlaylistId, nextState);
  } catch { /* best-effort */ }
}

/**
 * Host: mute/unmute a participant's track suggestions.
 *
 * Symmetric — pass `blocked: true` to add the username to
 * `state.suggestionBlocked`, `false` to remove it. The participant remains
 * in the session and continues to appear in the participants list; only new
 * outbox entries are silently dropped during the host's sweep. The guest UI
 * reads the same flag and disables its own Suggest controls so the user
 * sees a clear "muted" state instead of silent failures.
 *
 * No-op outside host role, when the session isn't active, when the target
 * is the host themselves, or when the toggle wouldn't change anything.
 */
export async function setOrbitSuggestionBlocked(username: string, blocked: boolean): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host') return;
  const state = store.state;
  const sessionPlaylistId = store.sessionPlaylistId;
  if (!state || !sessionPlaylistId) return;
  if (username === state.host) return;

  const current = state.suggestionBlocked ?? [];
  const isBlocked = current.includes(username);
  if (blocked === isBlocked) return;

  const nextList = blocked
    ? [...current, username]
    : current.filter(u => u !== username);
  const nextState: OrbitState = { ...state, suggestionBlocked: nextList };
  useOrbitStore.getState().setState(nextState);
  try { await writeOrbitState(sessionPlaylistId, nextState); }
  catch { /* best-effort; next host tick will re-push state */ }
}
