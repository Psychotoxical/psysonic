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

function makeWire(probed: CapabilitySet, wireId: ScrobbleWire['wireId'] = 'audioscrobbler_v2'): ScrobbleWire {
  return {
    wireId,
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

  it('lets a runtime probe error survive a static "true" (invalid pasted token)', async () => {
    // listenbrainz declares scrobble:true statically, but a bad token makes the
    // probe report scrobble:error — the static flag must not mask it back to yes.
    registerWire(makeWire({
      scrobble: { status: 'error', message: 'Token invalid' },
      nowPlaying: { status: 'error', message: 'Token invalid' },
    }, 'listenbrainz'));
    const caps = await probeAccount(account({ presetId: 'listenbrainz', wireId: 'listenbrainz' }));
    expect(caps.scrobble).toEqual({ status: 'error', message: 'Token invalid' });
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
