import { getSong } from '../api/subsonicLibrary';
import { songToTrack } from '../utils/songToTrack';
import { createPlaylist, updatePlaylist, updatePlaylistMeta, deletePlaylist, getPlaylist, getPlaylists } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import { encodeSharePayload, decodeOrbitSharePayloadFromText } from './shareLink';
import {
  makeInitialOrbitState,
  orbitOutboxPlaylistName,
  orbitSessionPlaylistName,
  parseOrbitState,
  ORBIT_DEFAULT_MAX_USERS,
  ORBIT_PLAYLIST_PREFIX,
  ORBIT_STATE_MAX_BYTES,
  type OrbitOutboxMeta,
  type OrbitParticipant,
  type OrbitQueueItem,
  type OrbitState,
} from '../api/orbit';

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

// ── ID generation ───────────────────────────────────────────────────────

/** 8 lowercase hex chars — unique enough for concurrent-session collision-free naming. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ── Serialisation ───────────────────────────────────────────────────────

/**
 * Serialise the state blob for writing into a playlist comment. Emits a
 * plain JSON string. Throws when the output exceeds `ORBIT_STATE_MAX_BYTES`
 * — callers should trim optional fields (oldest queue entries / kicked
 * usernames) and retry, rather than write something truncated.
 */
export function serialiseOrbitState(state: OrbitState): string {
  const json = JSON.stringify(state);
  // Encode-length check — emoji-heavy session names could inflate UTF-8 bytes
  // beyond the string's .length count.
  const byteLen = new TextEncoder().encode(json).length;
  if (byteLen > ORBIT_STATE_MAX_BYTES) {
    throw new OrbitStateTooLarge(byteLen);
  }
  return json;
}

export class OrbitStateTooLarge extends Error {
  constructor(public readonly bytes: number) {
    super(`Orbit state blob (${bytes} bytes) exceeds ${ORBIT_STATE_MAX_BYTES} byte budget`);
    this.name = 'OrbitStateTooLarge';
  }
}

function serialiseOutboxMeta(meta: OrbitOutboxMeta): string {
  return JSON.stringify(meta);
}

// ── Remote reads ────────────────────────────────────────────────────────

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

// ── Remote writes ───────────────────────────────────────────────────────

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

// ── Host lifecycle ──────────────────────────────────────────────────────

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

// ── Store helpers used by the tick hook ────────────────────────────────

/** Merge a patch into the store's state blob, keeping nullability. */
export function patchOrbitState(patch: Partial<OrbitState>): OrbitState | null {
  const current = useOrbitStore.getState().state;
  if (!current) return null;
  const next: OrbitState = { ...current, ...patch };
  useOrbitStore.getState().setState(next);
  return next;
}

/**
 * Host-only: update the session settings and immediately push to Navidrome
 * so guests see the change on their next poll. No-op unless the caller is
 * the current host with an active session.
 */
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

export async function updateOrbitSettings(patch: Partial<import('../api/orbit').OrbitSettings>): Promise<void> {
  const store = useOrbitStore.getState();
  if (store.role !== 'host' || !store.state || !store.sessionPlaylistId) return;
  const mergedSettings: import('../api/orbit').OrbitSettings = {
    ...(store.state.settings ?? { autoApprove: true, autoShuffle: true }),
    ...patch,
  };
  const next: OrbitState = { ...store.state, settings: mergedSettings };
  store.setState(next);
  try { await writeOrbitState(store.sessionPlaylistId, next); }
  catch { /* best-effort; next host-tick will push the current state anyway */ }
}

// ── Share link ──────────────────────────────────────────────────────────

export interface OrbitShareLink {
  /** Base URL of the Navidrome server (decoded). */
  serverBase: string;
  /** Session id (8 hex chars). */
  sid: string;
}

/**
 * Parse an orbit invite from pasted text. Accepts the magic-string format
 * `psysonic2-<base64url-json>` (same prefix family as library shares and
 * server invites). The caller decides what to do on null (show toast, etc.).
 */
export function parseOrbitShareLink(text: string): OrbitShareLink | null {
  if (!text) return null;
  const payload = decodeOrbitSharePayloadFromText(text);
  if (!payload) return null;
  try { new URL(payload.srv); } catch { return null; }
  return { serverBase: payload.srv, sid: payload.sid };
}

/** Build an orbit invite magic string for a live session. */
export function buildOrbitShareLink(serverBase: string, sid: string): string {
  return encodeSharePayload({ srv: serverBase, k: 'orbit', sid });
}

// ── Playlist lookup ─────────────────────────────────────────────────────

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

// ── Guest lifecycle ─────────────────────────────────────────────────────

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

// ── Track pipeline ──────────────────────────────────────────────────────

/**
 * Guest: suggest a track to the session.
 *
 * Appends the track to our own outbox playlist. The host's next sweep will
 * consume it and publish the authoritative queue update in the state blob.
 * No state mutation here — the guest never touches canonical state.
 */
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
 * Stable per-suggestion key across reshuffles — `addedBy`, `addedAt` and
 * `trackId` are all immutable once the host sweep has written them.
 * Shared between the host tick and the manual-approval UI.
 */
export const suggestionKey = (q: OrbitQueueItem): string =>
  `${q.addedBy}:${q.addedAt}:${q.trackId}`;

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

// ── Host-side outbox sweep ──────────────────────────────────────────────

interface OutboxSnapshot {
  user: string;
  outboxPlaylistId: string;
  /** Track IDs currently sitting in the outbox — these are the new suggestions. */
  trackIds: string[];
  /** Last heartbeat timestamp parsed from the outbox comment, or 0 if missing/broken. */
  lastHeartbeat: number;
}

/** Extract `<username>` from a filename matching `__psyorbit_<sid>_from_<username>__`. */
function parseOutboxPlaylistName(name: string, sid: string): string | null {
  const prefix = `${ORBIT_PLAYLIST_PREFIX}${sid}_from_`;
  if (!name.startsWith(prefix) || !name.endsWith('__')) return null;
  const user = name.slice(prefix.length, name.length - 2);
  return user.length > 0 ? user : null;
}

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

// ── State-blob construction from sweep results ─────────────────────────

/** How long we consider a heartbeat still fresh. Longer than the guest tick so a single missed beat is tolerated. */
export const ORBIT_HEARTBEAT_ALIVE_MS = 30_000;

/**
 * Grace window for the app-start orphan sweep. A session on the user's
 * other device or a browser that briefly restarted must NOT be deleted
 * by this sweep. 5 min matches the guest-side host-timeout threshold:
 * if a session is silent for that long, it's fair to treat it as dead;
 * anything shorter is a real restart and must survive.
 */
export const ORBIT_ORPHAN_TTL_MS = 5 * 60_000;

/**
 * Legacy / fallback shuffle cadence. New sessions store their own interval
 * in `OrbitState.settings.shuffleIntervalMin`; `effectiveShuffleIntervalMs`
 * resolves that against this constant for sessions created before the
 * field existed.
 */
export const ORBIT_SHUFFLE_INTERVAL_MS = 15 * 60_000;

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
 * How long a soft-`removed` marker stays in the state blob. Long enough for
 * the affected guest's 2.5 s read tick to surface the modal even after a
 * one-tick miss; short enough that the marker doesn't bloat state if the
 * guest never reconnects.
 */
export const ORBIT_REMOVED_TTL_MS = 60_000;

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

// ── Host-side moderation ────────────────────────────────────────────────

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
