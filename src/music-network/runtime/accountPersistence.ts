// Migration + validation for persisted Music Network state.
//
// Migrates the legacy flat lastfm* auth-store fields into a Last.fm account on
// first rehydrate, and defensively sanitizes any persisted account list. The
// legacy nowPlayingEnabled toggle is intentionally NOT touched here — it stays a
// global setting and gates dispatchNowPlaying at the playback call-site, so
// now-playing behaviour is preserved exactly.

import type { MusicNetworkState, PersistedAccount } from '../core/accounts';
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
    return { scrobblingMasterEnabled, enrichmentPrimaryId: null, accounts: [] };
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
  return { scrobblingMasterEnabled, enrichmentPrimaryId: id, accounts: [account] };
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
