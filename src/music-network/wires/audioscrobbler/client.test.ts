// Error-classification characterization for the Audioscrobbler transport client.
//
// The numeric error codes collide across providers (Last.fm code 4 = auth
// failure, but Rocksky code 4 = a server-side 500). The classifier must therefore
// flip to AUTH_SESSION_INVALID only on the unambiguous Last.fm session codes
// (9/14) or an auth-shaped message — and treat everything else, including a
// Rocksky 500, as a plain NETWORK error so the account is not bounced to a
// reconnect state. These tests pin that boundary.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioscrobblerCall, type AudioscrobblerEndpoint } from './client';

const invokeMock = vi.mocked(invoke);

const EP: AudioscrobblerEndpoint = {
  baseUrl: 'https://ws.audioscrobbler.com/2.0',
  apiKey: 'k',
  apiSecret: 's',
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe('audioscrobblerCall — success path', () => {
  it('returns the invoke result and forwards params as entries + signing flags', async () => {
    invokeMock.mockResolvedValue({ ok: true });
    const out = await audioscrobblerCall(EP, { method: 'track.scrobble', sk: 'x' }, true, false);

    expect(out).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith('audioscrobbler_request', {
      baseUrl: EP.baseUrl,
      params: [['method', 'track.scrobble'], ['sk', 'x']],
      sign: true,
      get: false,
      apiKey: 'k',
      apiSecret: 's',
    });
  });
});

describe('audioscrobblerCall — session-invalid classification (signed calls)', () => {
  it.each([
    ['Audioscrobbler 9 — Invalid session key', 'numeric code 9'],
    ['Audioscrobbler 14 — token has not been authorized', 'numeric code 14'],
    ['Authentication Failed: nope', 'auth-shaped message'],
    ['invalid session supplied', 'invalid-session message'],
    ['invalid token', 'invalid-token message'],
  ])('flips AUTH_SESSION_INVALID on %s (%s)', async (msg) => {
    invokeMock.mockRejectedValue(msg);
    await expect(audioscrobblerCall(EP, { method: 'track.scrobble', sk: 'x' }, true)).rejects.toMatchObject({
      code: 'AUTH_SESSION_INVALID',
    });
  });
});

describe('audioscrobblerCall — NETWORK classification (collision guards)', () => {
  it('treats a code-4 (Rocksky 500 collision) as NETWORK, not session-invalid', async () => {
    // Rocksky returns code 4 ("Failed to parse scrobbles") as a 500 — must NOT
    // bounce the account to reconnect.
    invokeMock.mockRejectedValue('Audioscrobbler 4 — Failed to parse scrobbles');
    await expect(audioscrobblerCall(EP, { method: 'track.scrobble', sk: 'x' }, true)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('treats a generic server/network failure as NETWORK', async () => {
    invokeMock.mockRejectedValue(new Error('500 Internal Server Error'));
    await expect(audioscrobblerCall(EP, { method: 'user.getInfo' }, false, true)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('never classifies an unsigned call as session-invalid, even on an auth-shaped message', async () => {
    invokeMock.mockRejectedValue('Authentication Failed');
    await expect(audioscrobblerCall(EP, { method: 'track.getInfo' }, false)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });
});
