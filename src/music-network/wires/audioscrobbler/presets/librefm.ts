// Libre.fm — Audioscrobbler v2 preset (full enrichment, bundled keys).
//
// Libre.fm implements the Last.fm 2.0 web API ("we implement the Last.fm API"),
// so it reuses the Audioscrobbler wire unchanged — only endpoints differ. The
// GNU FM family requires the trailing slash on apiBase. Bundled key/secret are
// the app's registered Libre.fm credentials; auth.getToken is verified live.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const LIBREFM_API_KEY = 'cbec96011b3ff276f45111d74121e690';
const LIBREFM_API_SECRET = 'ef60e4ba036e22d912526c488854bd6a';

const manifest: PresetManifest = {
  presetId: 'librefm',
  wireId: 'audioscrobbler_v2',
  displayName: 'Libre.fm',
  descriptionKey: 'musicNetwork.presets.librefm.desc',
  icon: 'librefm',
  category: 'public_audioscrobbler',
  endpoints: {
    apiBase: 'https://libre.fm/2.0/',
    authBase: 'https://libre.fm/api/auth/',
    profileBase: 'https://libre.fm',
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

export const librefmPreset: BuiltinPreset = {
  manifest,
  bundled: { apiKey: LIBREFM_API_KEY, apiSecret: LIBREFM_API_SECRET },
};
