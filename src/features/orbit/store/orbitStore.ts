import { create } from 'zustand';
import type { OrbitState } from '@/features/orbit/api/orbit';

/**
 * Orbit — local session store.
 *
 * Mirrors the remote canonical state for the UI, plus a handful of
 * client-only fields (our role in the session, the playlist ids we're
 * bound to, lifecycle phase). Not persisted — a session is transient by
 * design; if the app restarts mid-session, we re-join on next open
 * rather than resurrect stale local state.
 *
 * Phase 1 is intentionally thin: only `set`/`reset` plumbing so later
 * phases (host/guest lifecycle, track pipeline) can drop into place
 * without touching the store shape.
 */

export type OrbitRole = 'host' | 'guest';

/** Fine-grained lifecycle phase. Drives which modal/indicator UI is visible. */
export type OrbitPhase =
  /** No session bound. */
  | 'idle'
  /** Host: creating the session playlist and seeding state. */
  | 'starting'
  /** Guest: auth + lookup before commit. */
  | 'joining'
  /** Session established; polling cycle active. */
  | 'active'
  /** Host ended the session; showing exit modal. */
  | 'ended'
  /** Unrecoverable error (server unreachable, playlist vanished, etc.). */
  | 'error';

interface OrbitStore {
  /** Current role in the session, or null when idle. */
  role: OrbitRole | null;
  /** Active session id, or null. */
  sessionId: string | null;
  /** Navidrome playlist id of the canonical session playlist. */
  sessionPlaylistId: string | null;
  /** Navidrome playlist id of our own outbox (exists for both host and guest). */
  outboxPlaylistId: string | null;
  /** Lifecycle phase. */
  phase: OrbitPhase;
  /** Latest-known canonical state (last poll). Null while starting/joining. */
  state: OrbitState | null;
  /** Human-readable error when `phase === 'error'`. */
  errorMessage: string | null;
  /**
   * Wall-clock ms when this client joined the current session (host: start
   * time, guest: join time). Used to disambiguate stale `removed`-list
   * entries from a fresh re-join after a remove. Null when idle.
   */
  joinedAt: number | null;
  /**
   * Guest-only: track ids the local client has suggested but the host
   * hasn't yet merged into the shared queue. Filled by
   * `suggestOrbitTrack`, drained by the guest tick once the id appears
   * in `state.queue` / `state.currentTrack`. In-memory only — a rejoin
   * starts empty, any still-pending ids either land or get dropped by
   * the host's next sweep anyway.
   */
  pendingSuggestions: string[];
  /**
   * Host-only: suggestionKeys (see suggestionKey() in utils/orbit) that
   * the host has already merged into the play queue — whether via
   * auto-approve or an explicit Approve button. Stops the host tick
   * from re-inserting the same item on every sweep.
   */
  mergedSuggestionKeys: string[];
  /**
   * Host-only: suggestionKeys that the host explicitly declined. Keeps
   * them out of the merge pipeline AND out of the pending-approvals UI
   * so a declined suggestion doesn't keep begging for attention.
   */
  declinedSuggestionKeys: string[];

  // ── Setters (Phase 1 scaffolding; later phases add real actions) ────────
  setPhase: (phase: OrbitPhase) => void;
  setRole: (role: OrbitRole | null) => void;
  setSessionBinding: (args: {
    sessionId: string | null;
    sessionPlaylistId: string | null;
    outboxPlaylistId: string | null;
  }) => void;
  setState: (state: OrbitState | null) => void;
  setError: (message: string | null) => void;
  addPendingSuggestion: (trackId: string) => void;
  /** Keep only the pending ids that are NOT yet observable in the shared queue. */
  reconcilePendingSuggestions: (landedTrackIds: Set<string>) => void;
  /** Host: mark a suggestion as merged so the tick stops re-proposing it. */
  addMergedSuggestion: (key: string) => void;
  /** Host: mark a suggestion as declined so the approval UI and tick ignore it. */
  addDeclinedSuggestion: (key: string) => void;
  /** Tear down the session locally. Does NOT clean up remote playlists. */
  reset: () => void;
}

const initialState = {
  role: null,
  sessionId: null,
  sessionPlaylistId: null,
  outboxPlaylistId: null,
  phase: 'idle' as OrbitPhase,
  state: null,
  errorMessage: null,
  joinedAt: null,
  pendingSuggestions: [] as string[],
  mergedSuggestionKeys: [] as string[],
  declinedSuggestionKeys: [] as string[],
} satisfies Omit<OrbitStore,
  | 'setPhase' | 'setRole' | 'setSessionBinding' | 'setState' | 'setError'
  | 'addPendingSuggestion' | 'reconcilePendingSuggestions'
  | 'addMergedSuggestion' | 'addDeclinedSuggestion' | 'reset'
>;

export const useOrbitStore = create<OrbitStore>()((set) => ({
  ...initialState,

  setPhase: (phase) => set({ phase }),
  setRole: (role) => set({ role }),
  setSessionBinding: ({ sessionId, sessionPlaylistId, outboxPlaylistId }) =>
    set({ sessionId, sessionPlaylistId, outboxPlaylistId }),
  setState: (state) => set({ state }),
  setError: (message) => set({ phase: message ? 'error' : 'idle', errorMessage: message }),
  addPendingSuggestion: (trackId) => set(s => (
    s.pendingSuggestions.includes(trackId)
      ? s
      : { pendingSuggestions: [...s.pendingSuggestions, trackId] }
  )),
  reconcilePendingSuggestions: (landedTrackIds) => set(s => {
    const next = s.pendingSuggestions.filter(id => !landedTrackIds.has(id));
    return next.length === s.pendingSuggestions.length ? s : { pendingSuggestions: next };
  }),
  addMergedSuggestion: (key) => set(s => (
    s.mergedSuggestionKeys.includes(key)
      ? s
      : { mergedSuggestionKeys: [...s.mergedSuggestionKeys, key] }
  )),
  addDeclinedSuggestion: (key) => set(s => (
    s.declinedSuggestionKeys.includes(key)
      ? s
      : { declinedSuggestionKeys: [...s.declinedSuggestionKeys, key] }
  )),
  reset: () => set({ ...initialState }),
}));
