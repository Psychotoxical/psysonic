// Last.fm — default Audioscrobbler v2 preset (full enrichment, bundled keys).
//
// These are the same application credentials the legacy src/api/lastfm.ts used;
// they move here so the bundled key is owned by the preset, not a loose module
// constant. Last.fm is the parity baseline and the default enrichment primary.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const LASTFM_API_KEY = '9917fb39049225a13bec225ad6d49054';
const LASTFM_API_SECRET = '03817dda02bee87a178aab7581abae3b';

const manifest: PresetManifest = {
  presetId: 'lastfm',
  wireId: 'audioscrobbler_v2',
  displayName: 'Last.fm',
  descriptionKey: 'musicNetwork.presets.lastfm.desc',
  icon: 'lastfm',
  category: 'public_audioscrobbler',
  endpoints: {
    apiBase: 'https://ws.audioscrobbler.com/2.0/',
    authBase: 'https://www.last.fm/api/auth/',
    profileBase: 'https://www.last.fm',
  },
  credentials: 'bundled',
  defaultRoles: {
    scrobble: true,
    enrichmentEligible: true,
  },
  staticCapabilities: {
    scrobble: true,
    nowPlaying: true,
  },
  authStrategy: 'token_poll',
  fields: [],
};

export const lastfmPreset: BuiltinPreset = {
  manifest,
  bundled: { apiKey: LASTFM_API_KEY, apiSecret: LASTFM_API_SECRET },
};
