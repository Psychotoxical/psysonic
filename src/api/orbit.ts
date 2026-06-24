/**
 * Orbit — shared-session state types.
 *
 * The canonical state blob lives in the comment field of a dedicated
 * server-side playlist (`__psyorbit_[sid]__`). Host writes, guests read.
 * Per-user "outbox" playlists (`__psyorbit_[sid]_from_[username]__`)
 * carry suggestions + heartbeats the other way.
 *
 * This file is types + a few pure helpers only — no network, no store.
 */

/** Bump whenever the on-wire schema changes incompatibly. */
export const ORBIT_STATE_VERSION = 3 as const;

/** Prefix for the canonical session playlist name. Append an 8-hex session id. */
export const ORBIT_PLAYLIST_PREFIX = '__psyorbit_';

/** Full canonical session playlist name for a given session id. */
export function orbitSessionPlaylistName(sessionId: string): string {
  return `${ORBIT_PLAYLIST_PREFIX}${sessionId}__`;
}

/** Full per-user outbox playlist name. Host reads these, guests own one. */
export function orbitOutboxPlaylistName(sessionId: string, username: string): string {
  return `${ORBIT_PLAYLIST_PREFIX}${sessionId}_from_${username}__`;
}

/** One queued/current track + who added it, for attribution. */
export interface OrbitQueueItem {
  trackId: string;
  /** Navidrome username of the participant who suggested this track. */
  addedBy: string;
  /** Wall-clock ms when the host consumed this track from its originator's outbox. */
  addedAt: number;
}

/** One participant's presence record. */
export interface OrbitParticipant {
  user: string;
  /** Wall-clock ms when the host first registered this participant. */
  joinedAt: number;
  /** Wall-clock ms of the participant's most recent outbox heartbeat. */
  lastHeartbeat: number;
}

/**
 * The canonical session state — exactly what's serialised into the
 * session playlist's comment field. Keep lean; the comment has a ~4 KB
 * self-imposed budget.
 */
export interface OrbitState {
  v: typeof ORBIT_STATE_VERSION;
  /** Session id (8 hex chars). */
  sid: string;
  /** Navidrome username of the host. */
  host: string;
  /** Human-readable session name set by the host at start. */
  name: string;
  /** Epoch ms when the session was created. */
  started: number;
  /** Host-configurable cap on concurrent participants. */
  maxUsers: number;
  /** Currently-playing track (host's playback), or null when stopped. */
  currentTrack: OrbitQueueItem | null;
  /** Host's live play/pause state. */
  isPlaying: boolean;
  /** Host's last reported playback position in ms. */
  positionMs: number;
  /** Wall-clock ms of the `positionMs` snapshot, for drift calculation. */
  positionAt: number;
  /** Upcoming queue (not including `currentTrack`). */
  queue: OrbitQueueItem[];
  /**
   * Snapshot of the host's actual upcoming play queue (everything after
   * `queueIndex`), capped at `ORBIT_PLAY_QUEUE_LIMIT` to fit the state-blob
   * byte budget. Used by the guest view so guests see what's next in the
   * host's player rather than just the suggestions backlog. `addedBy`
   * carries the original suggester when known, otherwise the host.
   */
  playQueue?: { trackId: string; addedBy: string }[];
  /**
   * Total length of the host's upcoming play queue, even when `playQueue`
   * was truncated. Lets the guest UI render a "+ N more" hint.
   */
  playQueueTotal?: number;
  /** Epoch ms of the last queue shuffle. */
  lastShuffle: number;
  /** Currently-present participants (excluding the host). */
  participants: OrbitParticipant[];
  /** Usernames blocked from re-joining this session. */
  kicked: string[];
  /**
   * Soft-removed users — short-lived markers (TTL `ORBIT_REMOVED_TTL_MS`)
   * so the affected guest's next poll surfaces a "you were removed" modal.
   * Unlike `kicked`, the user is NOT blocked from re-joining via the
   * invite link. Aged out by the host's sweep tick.
   */
  removed?: { user: string; at: number }[];
  /** Set when the host has ended the session; guests should exit on next poll. */
  ended?: boolean;
  /** Host-settable session rules; absent on older clients — treat missing as all-defaults. */
  settings?: OrbitSettings;
  /**
   * Usernames muted by the host: their outbox is still polled (so heartbeats
   * keep them visible as participants) but new track suggestions are dropped
   * before they reach the approval list. Symmetric — host can re-enable.
   */
  suggestionBlocked?: string[];
}

/**
 * Host-configurable rules. All default to `true`, i.e. the feature runs
 * "all on" for new sessions. Toggled via the Orbit-bar settings popover.
 */
/** Minute presets offered to the host in the Orbit settings popover. */
export const ORBIT_SHUFFLE_INTERVAL_PRESETS_MIN = [1, 5, 10, 15, 30] as const;
export type OrbitShuffleIntervalMin = typeof ORBIT_SHUFFLE_INTERVAL_PRESETS_MIN[number];

/**
 * Host's playback-transition preferences, mirrored into the session so guests
 * blend tracks the same way the host does (otherwise each client uses its own
 * local transition settings, re-introducing the drift the Catch-Up button
 * exists to fix). Optional on the wire — a session hosted by a build that
 * predates transition sync simply omits it, and guests keep their own.
 */
export interface OrbitTransitionSettings {
  crossfadeEnabled: boolean;
  crossfadeSecs: number;
  crossfadeTrimSilence: boolean;
  autodjSmoothSkip: boolean;
  gaplessEnabled: boolean;
  /** Optional — absent on sessions hosted by builds before overlap-cap sync. */
  autodjOverlapCapMode?: 'auto' | 'limit';
  autodjOverlapCapSec?: number;
}

export interface OrbitSettings {
  /** Guest suggestions go straight into the host's play queue. */
  autoApprove: boolean;
  /** Whether the auto-shuffle cycle runs at all. */
  autoShuffle: boolean;
  /**
   * Minutes between each auto-shuffle cycle. Must be one of
   * `ORBIT_SHUFFLE_INTERVAL_PRESETS_MIN`. Older sessions that predate this
   * field fall back to 15 via `effectiveShuffleIntervalMs`.
   */
  shuffleIntervalMin?: OrbitShuffleIntervalMin;
  /**
   * Host's track-transition prefs (crossfade / gapless / AutoDJ), refreshed
   * every host tick from the host's own playback settings. Guests adopt these
   * for the session and restore their own on leave. Optional: absent on
   * pre-transition-sync sessions.
   */
  transitions?: OrbitTransitionSettings;
}

export const ORBIT_DEFAULT_SETTINGS: OrbitSettings = {
  // Off by default — host decides per suggestion via the approval list.
  autoApprove: false,
  autoShuffle: true,
  shuffleIntervalMin: 15,
};

/** What the guest's outbox-playlist comment holds (heartbeat only, for now). */
export interface OrbitOutboxMeta {
  /** Wall-clock ms of this heartbeat. */
  ts: number;
}

/** Our self-imposed limit on serialised `OrbitState`. Drop oldest non-essential fields if exceeded. */
export const ORBIT_STATE_MAX_BYTES = 4096;

/** Default value of `OrbitState.maxUsers` when the host hasn't picked one. */
export const ORBIT_DEFAULT_MAX_USERS = 10;

/**
 * Hard cap on `playQueue` length. ~30 tracks × ~50 bytes each ≈ 1.5 KB,
 * leaving room for the rest of the state blob under `ORBIT_STATE_MAX_BYTES`.
 * Excess upcoming tracks are surfaced via the `playQueueTotal` count so the
 * guest UI can show a "+ N more" hint instead of pretending there's nothing.
 */
export const ORBIT_PLAY_QUEUE_LIMIT = 30;

/**
 * Build a fresh state blob for a brand-new session. Used by the host on start.
 */
export function makeInitialOrbitState(args: {
  sid: string;
  host: string;
  name: string;
  maxUsers?: number;
}): OrbitState {
  const now = Date.now();
  return {
    v: ORBIT_STATE_VERSION,
    sid: args.sid,
    host: args.host,
    name: args.name,
    started: now,
    maxUsers: args.maxUsers ?? ORBIT_DEFAULT_MAX_USERS,
    currentTrack: null,
    isPlaying: false,
    positionMs: 0,
    positionAt: now,
    queue: [],
    lastShuffle: now,
    participants: [],
    kicked: [],
    removed: [],
    suggestionBlocked: [],
    playQueue: [],
    playQueueTotal: 0,
    settings: { ...ORBIT_DEFAULT_SETTINGS },
  };
}

/**
 * Validate + parse an incoming state blob (untrusted JSON from the playlist
 * comment). Returns null on structural mismatch or schema-version drift.
 */
export function parseOrbitState(raw: unknown): OrbitState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<OrbitState>;
  if (s.v !== ORBIT_STATE_VERSION) return null;
  if (typeof s.sid !== 'string' || typeof s.host !== 'string') return null;
  if (typeof s.name !== 'string' || typeof s.started !== 'number') return null;
  if (typeof s.maxUsers !== 'number' || typeof s.isPlaying !== 'boolean') return null;
  if (typeof s.positionMs !== 'number' || typeof s.positionAt !== 'number') return null;
  if (!Array.isArray(s.queue) || !Array.isArray(s.participants) || !Array.isArray(s.kicked)) return null;
  if (typeof s.lastShuffle !== 'number') return null;
  // currentTrack can be null or an object — no deeper validation here; the
  // producer is our own code and an item with missing fields would only hurt
  // the attribution UI, not correctness.
  // `removed` is optional (older hosts won't write it); coerce to [] if absent or malformed.
  if (!Array.isArray(s.removed)) s.removed = [];
  // `suggestionBlocked` is optional too — older hosts predate the mute feature.
  if (!Array.isArray(s.suggestionBlocked)) s.suggestionBlocked = [];
  // `playQueue` / `playQueueTotal` are optional (older hosts won't write them).
  if (!Array.isArray(s.playQueue)) s.playQueue = [];
  if (typeof s.playQueueTotal !== 'number') s.playQueueTotal = (s.playQueue?.length ?? 0);
  return s as OrbitState;
}

/** Quickly derive the host's estimated live playback position on a guest. */
export function estimateLivePosition(state: OrbitState, nowMs: number): number {
  if (!state.isPlaying) return state.positionMs;
  return state.positionMs + (nowMs - state.positionAt);
}
