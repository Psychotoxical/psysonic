// Migration + validation for persisted Music Network state.
//
// Migrates the legacy flat lastfm* auth-store fields into a Last.fm account on
// first rehydrate, and defensively sanitizes any persisted account list. The
// legacy nowPlayingEnabled toggle is intentionally NOT touched here — it stays a
// global setting and gates dispatchNowPlaying at the playback call-site, so
// now-playing behaviour is preserved exactly.

import type { MusicNetworkState, PersistedAccount, QueuedScrobble } from '../core/accounts';
import { getPreset } from '../registry/presetRegistry';

export interface LegacyLastfmState {
  lastfmSessionKey?: string;
  lastfmUsername?: string;
  scrobblingEnabled?: boolean;
}

/**
 * Builds the initial MusicNetworkState from legacy fields. Returns a populated
 * Last.fm account + primary when a legacy session key exists; otherwise an empty
 * state (master toggle still carried over). No data loss: the session key,
 * username and scrobbling preference are all preserved.
 */
export function migrateLegacyLastfm(
  legacy: LegacyLastfmState,
  newId: () => string,
): MusicNetworkState {
  const scrobblingMasterEnabled = legacy.scrobblingEnabled ?? true;
  const sessionKey = (legacy.lastfmSessionKey ?? '').trim();
  if (!sessionKey) {
    return { scrobblingMasterEnabled, enrichmentPrimaryId: null, accounts: [], scrobbleQueue: [] };
  }

  const preset = getPreset('lastfm');
  const id = newId();
  const account: PersistedAccount = {
    id,
    presetId: 'lastfm',
    wireId: 'audioscrobbler_v2',
    label: preset?.manifest.displayName ?? 'Last.fm',
    baseUrl: '',
    scrobbleEnabled: scrobblingMasterEnabled,
    sessionKey,
    username: legacy.lastfmUsername ?? '',
    apiKey: preset?.bundled?.apiKey ?? '',
    apiSecret: preset?.bundled?.apiSecret ?? '',
    sessionError: false,
    capabilities: {
      scrobble: { status: 'yes' },
      nowPlaying: { status: 'yes' },
    },
  };
  return { scrobblingMasterEnabled, enrichmentPrimaryId: id, accounts: [account], scrobbleQueue: [] };
}

const REQUIRED_STRING_FIELDS: (keyof PersistedAccount)[] = [
  'id', 'presetId', 'wireId', 'label', 'sessionKey',
];

/**
 * Drops malformed entries from a persisted account list (defensive against
 * tampered/old blobs). Keeps only objects with the required string fields and a
 * known preset.
 */
export function sanitizeAccounts(raw: unknown): PersistedAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is PersistedAccount => {
    if (!a || typeof a !== 'object') return false;
    const acc = a as Record<string, unknown>;
    if (REQUIRED_STRING_FIELDS.some(f => typeof acc[f] !== 'string')) return false;
    return getPreset(acc.presetId as PersistedAccount['presetId']) !== undefined;
  });
}

/**
 * Drops malformed entries from a persisted owed-scrobble queue.
 *
 * The queue is written verbatim by the store's blacklist-style `partialize`, so a
 * truncated or hand-edited blob reaches us unchecked. An entry missing its event
 * would throw on the first expiry comparison and wedge the queue permanently —
 * inside a `void flush()` with no one to catch it.
 */
export function sanitizeScrobbleQueue(raw: unknown): QueuedScrobble[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is QueuedScrobble => {
    if (!e || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.accountId !== 'string' || !entry.accountId) return false;
    if (typeof entry.attempts !== 'number' || !Number.isFinite(entry.attempts)) return false;
    if (typeof entry.nextAttemptAt !== 'number' || !Number.isFinite(entry.nextAttemptAt)) {
      return false;
    }
    const event = entry.event as Record<string, unknown> | undefined;
    if (!event || typeof event !== 'object') return false;
    // `timestamp` drives expiry; the rest is what the wires send on.
    if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false;
    return typeof event.title === 'string' && typeof event.artist === 'string';
  });
}
