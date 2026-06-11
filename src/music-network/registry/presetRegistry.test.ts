// Built-in preset catalogue invariants. Guards spec §5 (the v1 provider set) and
// §12 ("Maloja — 3 wire modes") against accidental drops or duplicate ids.

import { describe, expect, it } from 'vitest';
import { getPreset, listPresets } from './presetRegistry';
import type { PresetId } from '../core/types';

describe('built-in preset catalogue', () => {
  it('registers exactly the v1 provider set with unique ids', () => {
    const ids = listPresets().map(p => p.manifest.presetId).sort();
    expect(ids).toEqual([
      'custom_gnufm',
      'koito',
      'lastfm',
      'librefm',
      'listenbrainz',
      'maloja_compat',
      'maloja_listenbrainz',
      'maloja_native',
      'rocksky',
    ]);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it('exposes all three Maloja wire modes (spec §12)', () => {
    const maloja: PresetId[] = ['maloja_native', 'maloja_compat', 'maloja_listenbrainz'];
    for (const id of maloja) {
      const p = getPreset(id);
      expect(p, id).toBeDefined();
      expect(p!.manifest.category).toBe('self_hosted');
    }
    // The three modes ride three distinct transports.
    expect(getPreset('maloja_native')!.manifest.wireId).toBe('maloja_native');
    expect(getPreset('maloja_compat')!.manifest.wireId).toBe('audioscrobbler_v2');
    expect(getPreset('maloja_listenbrainz')!.manifest.wireId).toBe('listenbrainz');
  });

  it('only enrichment-eligible presets ride the audioscrobbler family as primary', () => {
    // Last.fm / Libre.fm / custom GNU FM are enrichment-eligible; the scrobble-only
    // audioscrobbler presets (Rocksky, maloja_compat) are not.
    const eligible = listPresets()
      .filter(p => p.manifest.defaultRoles.enrichmentEligible)
      .map(p => p.manifest.presetId)
      .sort();
    expect(eligible).toEqual(['custom_gnufm', 'lastfm', 'librefm']);
  });

  it('every preset declares a static scrobble capability and a description key', () => {
    for (const p of listPresets()) {
      expect(p.manifest.staticCapabilities.scrobble, p.manifest.presetId).toBe(true);
      expect(p.manifest.descriptionKey).toMatch(/^musicNetwork\.presets\./);
    }
  });
});
