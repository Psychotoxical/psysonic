import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  hasOpenSubsonicExtension,
  parseOpenSubsonicExtensions,
  probeAudiomusePluginWithCredentials,
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

describe('probeAudiomusePluginWithCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns present when sonicSimilarity is advertised', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okExtensions([{ name: 'sonicSimilarity', versions: [1] }]),
    );
    await expect(
      probeAudiomusePluginWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toBe('present');
  });

  it('returns absent when sonicSimilarity is missing', async () => {
    vi.mocked(axios.get).mockResolvedValue(
      okExtensions([{ name: 'playbackReport', versions: [1] }]),
    );
    await expect(
      probeAudiomusePluginWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toBe('absent');
  });

  it('returns error on request failure', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('boom'));
    await expect(
      probeAudiomusePluginWithCredentials('https://music.test', 'u', 'p'),
    ).resolves.toBe('error');
  });
});
