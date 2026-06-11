// Characterizes the on-the-wire request shape for scrobble / now-playing.
//
// `track.scrobble` must use the indexed batch/array form (`artist[0]`, `track[0]`,
// …) — Last.fm/Libre.fm accept the bare single form too, but Rocksky rejects it
// (server 500). Durations are rounded to whole seconds; the millisecond timestamp
// is floored to Unix seconds. now-playing keeps the single (non-indexed) form.
// Both calls must be signed (api_sig) and POSTed (get=false). This pins the body
// so a future refactor can't silently regress Rocksky.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioscrobblerWire } from './AudioscrobblerWire';
import type { WireContext } from '../../contracts/ScrobbleWire';
import type { PersistedAccount } from '../../core/accounts';

const invokeMock = vi.mocked(invoke);

function ctx(): WireContext {
  return {
    account: { id: 'a1', presetId: 'lastfm', wireId: 'audioscrobbler_v2' } as PersistedAccount,
    baseUrl: 'https://ws.audioscrobbler.com/2.0',
    profileBase: 'https://www.last.fm',
    apiKey: 'k',
    apiSecret: 's',
    sessionKey: 'SK',
    username: 'u',
  };
}

function lastCall() {
  const calls = invokeMock.mock.calls;
  return calls[calls.length - 1];
}

/** Pull the params entries out of the most recent invoke call as a plain map. */
function lastParams(): Record<string, string> {
  const arg = lastCall()?.[1] as { params: [string, string][] };
  return Object.fromEntries(arg.params);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe('scrobble — Audioscrobbler batch/array form', () => {
  it('emits indexed array keys with rounded duration and second-precision timestamp', async () => {
    await audioscrobblerWire.scrobble(ctx(), {
      title: 'Roygbiv',
      artist: 'Boards of Canada',
      album: 'Music Has the Right to Children',
      duration: 137.6,
      timestamp: 1_700_000_000_500,
    });

    expect(lastParams()).toEqual({
      method: 'track.scrobble',
      'track[0]': 'Roygbiv',
      'artist[0]': 'Boards of Canada',
      'album[0]': 'Music Has the Right to Children',
      'duration[0]': '138',
      'timestamp[0]': '1700000000',
      sk: 'SK',
    });
  });

  it('signs the call and POSTs it (sign=true, get=false)', async () => {
    await audioscrobblerWire.scrobble(ctx(), { title: 'T', artist: 'A', album: '', duration: 10, timestamp: 0 });
    const arg = lastCall()?.[1] as { sign: boolean; get: boolean };
    expect(arg.sign).toBe(true);
    expect(arg.get).toBe(false);
  });
});

describe('updateNowPlaying — single (non-indexed) form', () => {
  it('emits bare keys without array indices', async () => {
    await audioscrobblerWire.updateNowPlaying(ctx(), { title: 'T', artist: 'A', album: 'Al', duration: 200.4, timestamp: 0 });
    expect(lastParams()).toEqual({
      method: 'track.updateNowPlaying',
      track: 'T',
      artist: 'A',
      album: 'Al',
      duration: '200',
      sk: 'SK',
    });
  });
});
