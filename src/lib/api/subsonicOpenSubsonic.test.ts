import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { onInvoke } from '@/test/mocks/tauri';
import {
  fetchOpenSubsonicExtensionsWithCredentials,
  hasOpenSubsonicExtension,
  parseOpenSubsonicExtensions,
} from '@/lib/api/subsonicOpenSubsonic';

vi.mock('axios');

function okExtensions(extensions: unknown[]) {
  return {
    data: {
      'subsonic-response': {
        status: 'ok',
        openSubsonic: true,
        openSubsonicExtensions: extensions,
      },
    },
  };
}

describe('parseOpenSubsonicExtensions', () => {
  it('parses extension names and versions', () => {
    const parsed = parseOpenSubsonicExtensions([
      { name: 'sonicSimilarity', versions: [1] },
      { name: 'playbackReport', versions: [1, 2] },
      { bad: true },
    ]);
    expect(parsed).toEqual([
      { name: 'sonicSimilarity', versions: [1] },
      { name: 'playbackReport', versions: [1, 2] },
    ]);
  });
});

describe('hasOpenSubsonicExtension', () => {
  it('detects sonicSimilarity', () => {
    const extensions = parseOpenSubsonicExtensions([{ name: 'sonicSimilarity', versions: [1] }]);
    expect(hasOpenSubsonicExtension(extensions, 'sonicSimilarity')).toBe(true);
    expect(hasOpenSubsonicExtension(extensions, 'other')).toBe(false);
  });
});

describe('fetchOpenSubsonicExtensionsWithCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the advertised extension names', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okExtensions([{ name: 'sonicSimilarity', versions: [1] }, { name: 'playbackReport', versions: [1] }]),
    );
    await expect(
      fetchOpenSubsonicExtensionsWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toEqual(['sonicSimilarity', 'playbackReport']);
  });

  it('returns an empty list when none are advertised', async () => {
    vi.mocked(axios.get).mockResolvedValue(okExtensions([]));
    await expect(
      fetchOpenSubsonicExtensionsWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toEqual([]);
  });

  it('returns null on request failure', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('boom'));
    await expect(
      fetchOpenSubsonicExtensionsWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toBeNull();
  });

  it('routes through the native proxy with gate headers when a header profile is supplied', async () => {
    // Gate-header servers can't use the WebView (CORS preflight the gate rejects),
    // so this must go through the native `subsonic_proxy_request` command with the
    // header context forwarded — not an axios request.
    type ProxyArgs = {
      endpoint: string;
      httpContext: { customHeaders: { name: string; value: string }[] } | null;
    };
    let received: ProxyArgs | undefined;
    onInvoke('subsonic_proxy_request', (args) => {
      received = args as ProxyArgs;
      return JSON.stringify({
        'subsonic-response': { status: 'ok', openSubsonic: true, openSubsonicExtensions: [] },
      });
    });

    const result = await fetchOpenSubsonicExtensionsWithCredentials('https://music.test', 'u', 'p', {
      url: 'https://music.test',
      customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
      customHeadersApplyTo: 'public',
    });

    expect(result).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
    expect(received?.endpoint).toBe('getOpenSubsonicExtensions.view');
    expect(received?.httpContext?.customHeaders).toEqual([
      { name: 'CF-Access-Client-Secret', value: 'gate-secret' },
    ]);
  });
});
