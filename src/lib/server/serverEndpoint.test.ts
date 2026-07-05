import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/subsonic', () => ({
  pingWithCredentials: vi.fn(),
  pingWithCredentialsForProfile: vi.fn(),
}));

import { pingWithCredentialsForProfile } from '@/lib/api/subsonic';
import {
  allNormalizedAddresses,
  ensureConnectUrlResolved,
  getCachedConnectBaseUrl,
  invalidateReachableEndpointCache,
  isLanUrl,
  normalizeServerBaseUrl,
  pickReachableBaseUrl,
  serverAddressEndpoints,
  serverShareBaseUrl,
  subscribeConnectCache,
} from '@/lib/server/serverEndpoint';
import type { ServerProfile } from '@/store/authStoreTypes';

function makeProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'profile-1',
    name: 'Test',
    url: 'https://music.example.com',
    username: 'u',
    password: 'p',
    ...overrides,
  };
}

function pingOk(overrides: Partial<{ type: string; serverVersion: string; openSubsonic: boolean }> = {}) {
  return {
    ok: true as const,
    type: 'navidrome',
    serverVersion: '0.55.0',
    openSubsonic: true,
    ...overrides,
  };
}
function pingFail() {
  return { ok: false as const };
}

/** Initial connect ping + 2 retries (`serverEndpoint.ts`). */
const CONNECT_PROBE_ATTEMPTS = 3;

function mockDualAddressLanFailPublicOk() {
  vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url: string) => {
    if (url === 'http://192.168.0.10') return pingFail();
    return pingOk();
  });
}

describe('normalizeServerBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(normalizeServerBaseUrl('https://music.example.com/')).toBe(
      'https://music.example.com',
    );
  });

  it('prefixes http:// for a bare host', () => {
    expect(normalizeServerBaseUrl('music.example.com')).toBe('http://music.example.com');
  });

  it('returns empty for empty input', () => {
    expect(normalizeServerBaseUrl('')).toBe('');
  });
});

describe('isLanUrl — IPv4', () => {
  it.each([
    'http://localhost',
    'http://localhost:4533',
    'http://musicbox.local',
    'http://127.0.0.1',
    'http://127.5.6.7',
    'http://10.0.0.5',
    'http://192.168.1.10',
    'http://172.16.0.1',
    'http://172.31.255.255',
  ])('classifies %s as LAN', url => {
    expect(isLanUrl(url)).toBe(true);
  });

  it.each([
    'http://172.15.0.1',
    'http://172.32.0.1',
    'https://example.com',
    'https://music.example.com',
    'http://8.8.8.8',
  ])('classifies %s as public', url => {
    expect(isLanUrl(url)).toBe(false);
  });
});

describe('isLanUrl — IPv6', () => {
  it.each([
    'http://[::1]',
    'http://[::1]:4533',
    'http://[fe80::1]',
    'http://[fe80::abcd:1]',
    'http://[fc00::1]',
    'http://[fd12:3456:789a::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.0.1]',
  ])('classifies %s as LAN', url => {
    expect(isLanUrl(url)).toBe(true);
  });

  it.each([
    'http://[2001:db8::1]',
    'http://[::ffff:8.8.8.8]',
    'http://[2606:4700:4700::1111]',
  ])('classifies %s as public', url => {
    expect(isLanUrl(url)).toBe(false);
  });
});

describe('isLanUrl — edge cases', () => {
  it('handles bare hosts without scheme', () => {
    expect(isLanUrl('192.168.0.1')).toBe(true);
    expect(isLanUrl('example.com')).toBe(false);
  });

  it('returns false on empty / malformed', () => {
    expect(isLanUrl('')).toBe(false);
    expect(isLanUrl('not a url at all  ')).toBe(false);
  });
});

describe('allNormalizedAddresses', () => {
  it('returns single entry for profile with only url', () => {
    expect(
      allNormalizedAddresses({ url: 'https://music.example.com' }),
    ).toEqual(['https://music.example.com']);
  });

  it('returns both addresses preserving order', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10:4533',
      }),
    ).toEqual(['https://music.example.com', 'http://192.168.0.10:4533']);
  });

  it('dedupes identical normalized addresses', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com/',
        alternateUrl: 'https://music.example.com',
      }),
    ).toEqual(['https://music.example.com']);
  });

  it('drops empty alternateUrl', () => {
    expect(
      allNormalizedAddresses({
        url: 'https://music.example.com',
        alternateUrl: '',
      }),
    ).toEqual(['https://music.example.com']);
  });
});

describe('serverAddressEndpoints', () => {
  it('returns a single local endpoint for a LAN-only profile', () => {
    expect(
      serverAddressEndpoints({ url: 'http://192.168.0.10' }),
    ).toEqual([{ url: 'http://192.168.0.10', kind: 'local' }]);
  });

  it('puts LAN before public when public is primary', () => {
    expect(
      serverAddressEndpoints({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toEqual([
      { url: 'http://192.168.0.10', kind: 'local' },
      { url: 'https://music.example.com', kind: 'public' },
    ]);
  });

  it('keeps LAN-first when LAN is already primary', () => {
    expect(
      serverAddressEndpoints({
        url: 'http://192.168.0.10',
        alternateUrl: 'https://music.example.com',
      }),
    ).toEqual([
      { url: 'http://192.168.0.10', kind: 'local' },
      { url: 'https://music.example.com', kind: 'public' },
    ]);
  });

  it('preserves original order among endpoints of the same kind', () => {
    expect(
      serverAddressEndpoints({
        url: 'http://10.0.0.5',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toEqual([
      { url: 'http://10.0.0.5', kind: 'local' },
      { url: 'http://192.168.0.10', kind: 'local' },
    ]);
  });
});

describe('pickReachableBaseUrl', () => {
  beforeEach(() => {
    invalidateReachableEndpointCache();
    vi.mocked(pingWithCredentialsForProfile).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the single endpoint when it pings ok and caches it', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue(pingOk());
    const result = await pickReachableBaseUrl(makeProfile({ url: 'https://music.example.com' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe('https://music.example.com');
      expect(result.endpoint).toEqual({ url: 'https://music.example.com', kind: 'public' });
      expect(result.ping.ok).toBe(true);
      expect(result.ping.type).toBe('navidrome');
    }
    expect(getCachedConnectBaseUrl('profile-1')).toBe('https://music.example.com');
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(1);
  });

  it('prefers the LAN endpoint even when alternateUrl is the LAN one', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue(pingOk());
    const result = await pickReachableBaseUrl(
      makeProfile({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('http://192.168.0.10');
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls[0]![1]).toBe('http://192.168.0.10');
  });

  it('falls through to the public endpoint when LAN ping fails', async () => {
    vi.useFakeTimers();
    mockDualAddressLanFailPublicOk();
    const promise = pickReachableBaseUrl(
      makeProfile({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      }),
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://music.example.com');
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(CONNECT_PROBE_ATTEMPTS + 1);
    expect(getCachedConnectBaseUrl('profile-1')).toBe('https://music.example.com');
  });

  it('retries a flaky endpoint before declaring it unreachable', async () => {
    vi.useFakeTimers();
    vi.mocked(pingWithCredentialsForProfile)
      .mockResolvedValueOnce(pingFail())
      .mockResolvedValueOnce(pingOk());
    const promise = pickReachableBaseUrl(makeProfile({ url: 'https://music.example.com' }));
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://music.example.com');
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('returns unreachable and clears cache when every endpoint fails', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue(pingFail());
    // Seed a stale cache entry first.
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(makeProfile({ url: 'https://music.example.com' }));
    expect(getCachedConnectBaseUrl('profile-1')).toBe('https://music.example.com');

    vi.mocked(pingWithCredentialsForProfile).mockReset();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue(pingFail());
    vi.useFakeTimers();
    const unreachablePromise = pickReachableBaseUrl(makeProfile({ url: 'https://music.example.com' }));
    await vi.runAllTimersAsync();
    const result = await unreachablePromise;
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(getCachedConnectBaseUrl('profile-1')).toBeNull();
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(CONNECT_PROBE_ATTEMPTS);
  });

  it('returns unreachable when the profile has no usable url', async () => {
    const result = await pickReachableBaseUrl(makeProfile({ url: '' }));
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(pingWithCredentialsForProfile).not.toHaveBeenCalled();
  });

  it('tries the cached endpoint first on subsequent calls (sticky)', async () => {
    const profile = makeProfile({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10',
    });
    // First call: LAN responds ok, becomes cached.
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(profile);
    expect(getCachedConnectBaseUrl('profile-1')).toBe('http://192.168.0.10');

    // Second call: cached URL is tried first; sole ping happens against it.
    vi.mocked(pingWithCredentialsForProfile).mockClear();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    const result = await pickReachableBaseUrl(profile);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('http://192.168.0.10');
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls[0]![1]).toBe('http://192.168.0.10');
  });

  it('dedupes concurrent calls for the same profile (single shared probe)', async () => {
    // Two callers in the same tick must observe the same promise — without
    // the in-flight map both would ping every endpoint and race on the
    // cache write, with last-write-wins potentially clobbering the correct
    // LAN sticky a millisecond after it was set.
    let resolvePing: ((v: ReturnType<typeof pingOk>) => void) | null = null;
    vi.mocked(pingWithCredentialsForProfile).mockReturnValueOnce(
      new Promise(r => {
        resolvePing = r;
      }),
    );
    const profile = makeProfile({ url: 'http://192.168.0.10' });
    const p1 = pickReachableBaseUrl(profile);
    const p2 = pickReachableBaseUrl(profile);

    // Both calls saw a pending probe — only one ping should have been fired.
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(1);

    resolvePing!(pingOk());
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.baseUrl).toBe(r2.baseUrl);
    }
    expect(getCachedConnectBaseUrl('profile-1')).toBe('http://192.168.0.10');
  });

  it('starts a fresh probe after the in-flight one settles', async () => {
    // Once the previous probe resolves, the in-flight slot is freed and
    // the next call hits the network again (subject to the sticky cache).
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(makeProfile({ url: 'http://192.168.0.10' }));

    vi.mocked(pingWithCredentialsForProfile).mockClear();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(makeProfile({ url: 'http://192.168.0.10' }));
    expect(pingWithCredentialsForProfile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the natural order if the cached endpoint stops answering', async () => {
    const profile = makeProfile({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10',
    });
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(profile);
    expect(getCachedConnectBaseUrl('profile-1')).toBe('http://192.168.0.10');

    // LAN now fails; public answers.
    vi.mocked(pingWithCredentialsForProfile).mockClear();
    vi.useFakeTimers();
    mockDualAddressLanFailPublicOk();
    const fallbackPromise = pickReachableBaseUrl(profile);
    await vi.runAllTimersAsync();
    const result = await fallbackPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baseUrl).toBe('https://music.example.com');
    expect(getCachedConnectBaseUrl('profile-1')).toBe('https://music.example.com');
  });
});

describe('invalidateReachableEndpointCache', () => {
  beforeEach(() => {
    invalidateReachableEndpointCache();
    vi.mocked(pingWithCredentialsForProfile).mockReset();
  });

  it('clears a specific profile', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await ensureConnectUrlResolved(makeProfile({ id: 'a' }));
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await ensureConnectUrlResolved(makeProfile({ id: 'b' }));
    expect(getCachedConnectBaseUrl('a')).not.toBeNull();
    expect(getCachedConnectBaseUrl('b')).not.toBeNull();

    invalidateReachableEndpointCache('a');
    expect(getCachedConnectBaseUrl('a')).toBeNull();
    expect(getCachedConnectBaseUrl('b')).not.toBeNull();
  });

  it('clears everything when called with no argument', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await ensureConnectUrlResolved(makeProfile({ id: 'a' }));
    invalidateReachableEndpointCache();
    expect(getCachedConnectBaseUrl('a')).toBeNull();
  });
});

describe('subscribeConnectCache — connect-URL flip notifications', () => {
  beforeEach(() => {
    invalidateReachableEndpointCache();
    vi.mocked(pingWithCredentialsForProfile).mockReset();
  });

  it('notifies when a probe resolves a new endpoint and on a later flip', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConnectCache(listener);
    const profile = makeProfile({
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10',
    });

    // First probe: LAN answers → cache set → one notification.
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(profile);
    expect(listener).toHaveBeenCalledTimes(1);

    // LAN drops, public answers → cached URL flips → another notification.
    vi.useFakeTimers();
    mockDualAddressLanFailPublicOk();
    const flipPromise = pickReachableBaseUrl(profile);
    await vi.runAllTimersAsync();
    await flipPromise;
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('does not notify when the sticky endpoint is unchanged', async () => {
    const profile = makeProfile({ url: 'http://192.168.0.10' });
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(profile);

    const listener = vi.fn();
    const unsubscribe = subscribeConnectCache(listener);
    // Re-probe, same endpoint answers → cache value identical → no notification.
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(profile);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('notifies on explicit cache invalidation when an entry existed', async () => {
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValueOnce(pingOk());
    await pickReachableBaseUrl(makeProfile({ id: 'a' }));

    const listener = vi.fn();
    const unsubscribe = subscribeConnectCache(listener);
    invalidateReachableEndpointCache('a');
    expect(listener).toHaveBeenCalledTimes(1);
    // No-op invalidation (nothing cached) must stay silent.
    invalidateReachableEndpointCache('a');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe('serverShareBaseUrl', () => {
  it('returns the single address for a single-URL profile', () => {
    expect(serverShareBaseUrl({ url: 'https://music.example.com' })).toBe(
      'https://music.example.com',
    );
  });

  it('falls back to a normalized url even when empty', () => {
    // Defensive — never throws; downstream consumers tolerate the empty string.
    expect(serverShareBaseUrl({ url: '' })).toBe('');
  });

  it('prefers the public address by default when both are set', () => {
    expect(
      serverShareBaseUrl({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toBe('https://music.example.com');
  });

  it('still prefers public when the LAN address is the primary', () => {
    expect(
      serverShareBaseUrl({
        url: 'http://192.168.0.10',
        alternateUrl: 'https://music.example.com',
      }),
    ).toBe('https://music.example.com');
  });

  it('returns the LAN address when shareUsesLocalUrl is true', () => {
    expect(
      serverShareBaseUrl({
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
        shareUsesLocalUrl: true,
      }),
    ).toBe('http://192.168.0.10');
  });

  it('falls back to the first endpoint when no LAN exists and flag is set', () => {
    expect(
      serverShareBaseUrl({
        url: 'https://music.example.com',
        alternateUrl: 'https://music-alt.example.com',
        shareUsesLocalUrl: true,
      }),
    ).toBe('https://music.example.com');
  });

  it('falls back to the first endpoint when both are LAN and flag is off', () => {
    expect(
      serverShareBaseUrl({
        url: 'http://10.0.0.5',
        alternateUrl: 'http://192.168.0.10',
      }),
    ).toBe('http://10.0.0.5');
  });

  it('returns the first LAN endpoint when both are LAN and flag is on', () => {
    // Two LAN addresses + flag set: spec §5.1 says "local ?? endpoints[0]".
    // `find(isLanUrl)` returns the first LAN, which is endpoints[0] either
    // way — pin the test so future refactors don't accidentally drift.
    expect(
      serverShareBaseUrl({
        url: 'http://10.0.0.5',
        alternateUrl: 'http://192.168.0.10',
        shareUsesLocalUrl: true,
      }),
    ).toBe('http://10.0.0.5');
  });

  it('returns the first endpoint when both are public and flag is off', () => {
    // Reverse case: two publics, no LAN exists, flag default → publicEndpoint
    // matches the first one. Identity, but locks the rule down.
    expect(
      serverShareBaseUrl({
        url: 'https://music.example.com',
        alternateUrl: 'https://backup.example.com',
      }),
    ).toBe('https://music.example.com');
  });
});
