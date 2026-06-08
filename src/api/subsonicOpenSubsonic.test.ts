import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  fetchOpenSubsonicExtensionsWithCredentials,
  hasOpenSubsonicExtension,
  parseOpenSubsonicExtensions,
} from './subsonicOpenSubsonic';

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
});
