// CapabilityProbe — the preset manifest is the final authority over the wire's
// dynamic probe for the keys it declares. This is how two presets on the same
// wire diverge: Rocksky rides the Audioscrobbler wire (which optimistically
// probes nowPlaying:yes) but its manifest declares nowPlaying:false, so the
// merged result must report nowPlaying:no.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeAccount } from './CapabilityProbe';
import { __resetWires, registerWire } from '../registry/wireRegistry';
import type { ScrobbleWire } from '../contracts/ScrobbleWire';
import type { CapabilitySet } from '../core/capabilities';
import type { PersistedAccount } from '../core/accounts';

function makeWire(probed: CapabilitySet): ScrobbleWire {
  return {
    wireId: 'audioscrobbler_v2',
    supportsEnrichment: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    scrobble: vi.fn(),
    updateNowPlaying: vi.fn(),
    probe: async () => probed,
  };
}

function account(over: Partial<PersistedAccount> = {}): PersistedAccount {
  return {
    id: 'a1', presetId: 'rocksky', wireId: 'audioscrobbler_v2', label: 'Rocksky',
    baseUrl: '', scrobbleEnabled: true, sessionKey: 'sk', username: 'me',
    apiKey: 'k', apiSecret: 's', sessionError: false, capabilities: {},
    ...over,
  };
}

beforeEach(() => {
  __resetWires();
});

describe('probeAccount — manifest overrides probe', () => {
  it('forces nowPlaying:no for Rocksky even when the wire probes nowPlaying:yes', async () => {
    registerWire(makeWire({ scrobble: { status: 'yes' }, nowPlaying: { status: 'yes' } }));
    const caps = await probeAccount(account());
    expect(caps.nowPlaying?.status).toBe('no');
    expect(caps.scrobble?.status).toBe('yes');
  });

  it('keeps probed keys the manifest does not declare', async () => {
    registerWire(makeWire({
      scrobble: { status: 'yes' },
      nowPlaying: { status: 'yes' },
      similarArtists: { status: 'error', message: 'boom' },
    }));
    const caps = await probeAccount(account());
    // similarArtists is not in Rocksky's staticCapabilities → the probe stands.
    expect(caps.similarArtists).toEqual({ status: 'error', message: 'boom' });
  });
});
