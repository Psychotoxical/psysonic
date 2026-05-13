/**
 * Orbit cadence + TTL constants.
 *
 * Centralised so host/guest/state-math code reads from the same source of
 * truth. Defaults are deliberately chosen against observed Navidrome poll
 * cadences and real-world flake budgets.
 */

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
 * How long a soft-`removed` marker stays in the state blob. Long enough for
 * the affected guest's 2.5 s read tick to surface the modal even after a
 * one-tick miss; short enough that the marker doesn't bloat state if the
 * guest never reconnects.
 */
export const ORBIT_REMOVED_TTL_MS = 60_000;
