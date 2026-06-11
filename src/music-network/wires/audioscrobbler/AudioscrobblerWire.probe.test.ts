// Probe / connect-validation behaviour for the Audioscrobbler wire.
//
// Paste-auth presets (Rocksky, Maloja Audioscrobbler) have no browser flow, so
// the probe is the only place a pasted session key gets validated. It must flag
// an invalid key as scrobble:'error' (drives a connect toast) WITHOUT
// false-positiving a valid key on a scrobble-only service that rejects
// user.getInfo ("Unsupported method" is a NETWORK error, not an auth failure).
// Token-poll presets keep the unsigned enrichment probe untouched.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioscrobblerWire } from './AudioscrobblerWire';
import type { WireContext } from '../../contracts/ScrobbleWire';
import type { PersistedAccount } from '../../core/accounts';

const invokeMock = vi.mocked(invoke);

function ctx(authStrategy: WireContext['authStrategy']): WireContext {
  return {
    account: { id: 'a1', presetId: 'maloja_compat', wireId: 'audioscrobbler_v2' } as PersistedAccount,
    baseUrl: 'https://maloja.example/apis/audioscrobbler',
    profileBase: '',
    apiKey: '',
    apiSecret: '',
    sessionKey: 'SK',
    username: '',
    authStrategy,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('probe — paste-auth (api_key_only) validation', () => {
  it('flags scrobble:error when the signed validation hits an auth failure', async () => {
    invokeMock.mockRejectedValue('Audioscrobbler 9 — Invalid session key');
    const caps = await audioscrobblerWire.probe(ctx('api_key_only'));
    expect(caps.scrobble?.status).toBe('error');
  });

  it('leaves scrobble optimistic when the service rejects user.getInfo (Rocksky valid key)', async () => {
    // "Unsupported method" is a NETWORK error, not auth — a valid scrobble-only
    // key must NOT be reported as broken.
    invokeMock.mockRejectedValue('Audioscrobbler 6 — Unsupported method');
    const caps = await audioscrobblerWire.probe(ctx('api_key_only'));
    expect(caps.scrobble?.status).toBe('yes');
  });

  it('reports scrobble:yes + no enrichment when the validation succeeds', async () => {
    invokeMock.mockResolvedValue({ user: { name: 'me' } });
    const caps = await audioscrobblerWire.probe(ctx('api_key_only'));
    expect(caps.scrobble?.status).toBe('yes');
    expect(caps.similarArtists?.status).toBe('no');
  });
});

describe('probe — token-poll (enrichment) path is unchanged', () => {
  it('derives the enrichment set from an unsigned user.getInfo', async () => {
    invokeMock.mockResolvedValue({ user: { name: 'me' } });
    const caps = await audioscrobblerWire.probe(ctx('token_poll'));
    expect(caps.scrobble?.status).toBe('yes');
    expect(caps.similarArtists?.status).toBe('yes');
  });

  it('degrades to enrichment-only error when user.getInfo fails, keeping scrobble', async () => {
    invokeMock.mockRejectedValue(new Error('no user.getInfo here'));
    const caps = await audioscrobblerWire.probe(ctx('token_poll'));
    expect(caps.scrobble?.status).toBe('yes');
    expect(caps.similarArtists?.status).toBe('error');
  });
});
