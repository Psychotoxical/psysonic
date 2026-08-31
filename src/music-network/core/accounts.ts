// Music Network — account model.
//
// An Account is a user-connected instance of a preset. The persisted shape lives
// in the auth store (see runtime/accountPersistence.ts for migration). Roles
// decide fan-out (scrobble) and enrichment eligibility.

import type { CapabilitySet } from './capabilities';
import type { PresetId, ScrobbleEvent, WireId } from './types';

export interface AccountRoles {
  /** Account participates in scrobble fan-out when enabled + master on. */
  scrobble: boolean;
  /** Account may be chosen as the single enrichment primary. */
  enrichmentEligible: boolean;
}

/**
 * Persisted account record. Stored inside the auth store's MusicNetworkState.
 * Field names are intentionally generic — no `lastfm*` leakage.
 */
export interface PersistedAccount {
  id: string;
  presetId: PresetId;
  wireId: WireId;
  /** User-facing label (defaults to preset displayName, editable). */
  label: string;
  /** '' for fixed-host presets (Last.fm, Libre.fm, Rocksky). */
  baseUrl: string;
  scrobbleEnabled: boolean;
  sessionKey: string;
  username: string;
  apiKey: string;
  apiSecret: string;
  sessionError: boolean;
  capabilities: CapabilitySet;
  customFields?: Record<string, string>;
}

/** Runtime account view — persisted record plus resolved role flags. */
export interface Account extends PersistedAccount {
  roles: AccountRoles;
}

/** Partial update applied through the runtime. */
export type AccountPatch = Partial<
  Pick<
    PersistedAccount,
    | 'label'
    | 'baseUrl'
    | 'scrobbleEnabled'
    | 'sessionKey'
    | 'username'
    | 'apiKey'
    | 'apiSecret'
    | 'sessionError'
    | 'capabilities'
    | 'customFields'
  >
>;

/** Persisted top-level Music Network state (replaces flat `lastfm*` fields). */
export interface MusicNetworkState {
  /** Master switch for all scrobble fan-out (migrates from `scrobblingEnabled`). */
  scrobblingMasterEnabled: boolean;
  /** Single enrichment primary account id, or null. */
  enrichmentPrimaryId: string | null;
  accounts: PersistedAccount[];
  /**
   * Scrobbles that failed on a transient error and are owed to a destination.
   * Persisted, because a play cannot be repeated the way a star click can — the
   * user never sees the failure and has no way to replay the track.
   */
  scrobbleQueue: QueuedScrobble[];
}

/**
 * Which destination a play is owed to, in terms that survive a reconnect.
 *
 * Not the account id: repairing a rejected session means disconnect + connect,
 * and `connect` mints a new id, so an id-keyed entry would be orphaned by the
 * very act that makes it deliverable again. Preset, host and user identify the
 * same destination before and after.
 *
 * `baseUrl` is '' for fixed-host presets (Last.fm, Libre.fm, Rocksky), where the
 * preset alone is the host. `username` is '' for token-only providers; two such
 * accounts on the same host are then indistinguishable here, and a reconnect
 * adopts the owed plays — acceptable, since it is the same destination either way.
 */
export interface ScrobbleTargetRef {
  presetId: PresetId;
  baseUrl: string;
  username: string;
}

/** The destination identity of an account, for queue bookkeeping. */
export function scrobbleTargetRef(account: PersistedAccount): ScrobbleTargetRef {
  return {
    presetId: account.presetId,
    baseUrl: account.baseUrl,
    username: account.username,
  };
}

export function isSameScrobbleTarget(a: ScrobbleTargetRef, b: ScrobbleTargetRef): boolean {
  return a.presetId === b.presetId && a.baseUrl === b.baseUrl && a.username === b.username;
}

/**
 * One play owed to one destination. Fanned out per destination rather than per
 * play, so a play that reached two of three only retries the third.
 */
export interface QueuedScrobble {
  target: ScrobbleTargetRef;
  event: ScrobbleEvent;
  /** Delivery attempts so far; drives the backoff. */
  attempts: number;
  /**
   * Epoch ms before which no retry is made. Expiry keys off `event.timestamp`
   * instead — that is the play itself, and what the destination will reject as
   * too old.
   */
  nextAttemptAt: number;
}
