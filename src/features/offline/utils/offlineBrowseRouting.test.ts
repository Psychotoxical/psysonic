import { describe, expect, it } from 'vitest';
import {
  hasOfflineBrowseCapability,
  isPathOfflineBrowsable,
  resolveOfflineDisconnectNavAction,
} from '@/features/offline/utils/offlineBrowseRouting';

describe('offlineBrowseRouting', () => {
  it('hasOfflineBrowseCapability is true when any offline surface exists', () => {
    expect(hasOfflineBrowseCapability(false, false, false)).toBe(false);
    expect(hasOfflineBrowseCapability(true, false, false)).toBe(true);
    expect(hasOfflineBrowseCapability(false, true, false)).toBe(true);
    expect(hasOfflineBrowseCapability(false, false, true)).toBe(true);
  });

  it('isPathOfflineBrowsable covers library, detail, and local-only routes', () => {
    const ctx = [true, true, true, true] as const;
    expect(isPathOfflineBrowsable('/albums', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/album/abc', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/artist/abc', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/playlists', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/playlists/pl-1', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/now-playing', ...ctx)).toBe(true);
    expect(isPathOfflineBrowsable('/', ...ctx)).toBe(false);
    expect(isPathOfflineBrowsable('/playlists', true, true, true, false)).toBe(false);
  });

  it('resolveOfflineDisconnectNavAction stays when nothing offline', () => {
    expect(resolveOfflineDisconnectNavAction('/playlists', false, false, false, false, false))
      .toEqual({ kind: 'stay' });
    expect(resolveOfflineDisconnectNavAction('/albums', false, false, false, false, false))
      .toEqual({ kind: 'stay' });
  });

  it('resolveOfflineDisconnectNavAction reloads allowed pages', () => {
    expect(resolveOfflineDisconnectNavAction('/artists', false, true, false, false, false))
      .toEqual({ kind: 'stay-reload' });
    expect(resolveOfflineDisconnectNavAction('/playlists', false, false, false, true, true))
      .toEqual({ kind: 'stay-reload' });
  });

  it('resolveOfflineDisconnectNavAction redirects disallowed pages to all albums', () => {
    expect(resolveOfflineDisconnectNavAction('/playlists', false, true, false, false, false))
      .toEqual({ kind: 'redirect', to: '/albums' });
    expect(resolveOfflineDisconnectNavAction('/', false, true, false, false, false))
      .toEqual({ kind: 'redirect', to: '/albums' });
  });
});
