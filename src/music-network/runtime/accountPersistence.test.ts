import { describe, expect, it } from 'vitest';
import { migrateLegacyLastfm, sanitizeAccounts } from './accountPersistence';
import type { PersistedAccount } from '../core/accounts';

const newId = () => 'fixed-id';

describe('migrateLegacyLastfm', () => {
  it('creates a Last.fm account and primary from a legacy session, without data loss', () => {
    const result = migrateLegacyLastfm(
      { lastfmSessionKey: 'sk-abc', lastfmUsername: 'frank', scrobblingEnabled: true },
      newId,
    );
    expect(result.accounts).toHaveLength(1);
    const acc = result.accounts[0];
    expect(acc.presetId).toBe('lastfm');
    expect(acc.wireId).toBe('audioscrobbler_v2');
    expect(acc.sessionKey).toBe('sk-abc');
    expect(acc.username).toBe('frank');
    // bundled Last.fm credentials are filled from the preset
    expect(acc.apiKey).not.toBe('');
    expect(acc.apiSecret).not.toBe('');
    expect(result.enrichmentPrimaryId).toBe(acc.id);
    expect(result.scrobblingMasterEnabled).toBe(true);
    expect(acc.scrobbleEnabled).toBe(true);
  });

  it('carries the scrobbling preference into both master and account flags', () => {
    const off = migrateLegacyLastfm(
      { lastfmSessionKey: 'sk', lastfmUsername: 'u', scrobblingEnabled: false },
      newId,
    );
    expect(off.scrobblingMasterEnabled).toBe(false);
    expect(off.accounts[0].scrobbleEnabled).toBe(false);
  });

  it('produces an empty state (no account) when there is no legacy session', () => {
    const result = migrateLegacyLastfm({ scrobblingEnabled: true }, newId);
    expect(result.accounts).toEqual([]);
    expect(result.enrichmentPrimaryId).toBeNull();
    expect(result.scrobblingMasterEnabled).toBe(true);
  });

  it('defaults the master toggle to true when scrobblingEnabled is absent', () => {
    expect(migrateLegacyLastfm({}, newId).scrobblingMasterEnabled).toBe(true);
  });

  it('ignores a blank/whitespace session key', () => {
    expect(migrateLegacyLastfm({ lastfmSessionKey: '   ' }, newId).accounts).toEqual([]);
  });
});

describe('sanitizeAccounts', () => {
  const valid: PersistedAccount = {
    id: 'a1', presetId: 'lastfm', wireId: 'audioscrobbler_v2', label: 'Last.fm',
    baseUrl: '', scrobbleEnabled: true, sessionKey: 'sk', username: 'u',
    apiKey: 'k', apiSecret: 's', sessionError: false, capabilities: {},
  };

  it('keeps well-formed accounts with a known preset', () => {
    expect(sanitizeAccounts([valid])).toEqual([valid]);
  });

  it('drops non-arrays, malformed entries, and unknown presets', () => {
    expect(sanitizeAccounts(null)).toEqual([]);
    expect(sanitizeAccounts([{ id: 'x' }])).toEqual([]);
    expect(sanitizeAccounts([{ ...valid, presetId: 'bogus' }])).toEqual([]);
    expect(sanitizeAccounts([valid, { foo: 1 }])).toEqual([valid]);
  });
});
