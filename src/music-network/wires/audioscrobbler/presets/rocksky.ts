// Rocksky — Audioscrobbler v2 endpoint, scrobble destination only.
//
// Verified against the live API: /2.0 (no trailing slash) accepts POST
// track.scrobble with api_key + sk + MD5 api_sig, but rejects every other method
// ("Unsupported method") and has no auth.getToken. So Rocksky reuses the
// Audioscrobbler wire for scrobbling only, with a pasted session key (obtained
// via `rocksky login`) instead of the browser token-poll flow. No now-playing,
// no enrichment. Bundled app key/secret sign the requests.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const ROCKSKY_API_KEY = 'aa590b1f5e656bfbc658708206181b33';
const ROCKSKY_API_SECRET = '2299bf8cf402c0180381eca5a20d47dc';

const manifest: PresetManifest = {
  presetId: 'rocksky',
  wireId: 'audioscrobbler_v2',
  displayName: 'Rocksky',
  descriptionKey: 'musicNetwork.presets.rocksky.desc',
  icon: 'rocksky',
  category: 'public_audioscrobbler',
  endpoints: {
    apiBase: 'https://audioscrobbler.rocksky.app/2.0',
    profileBase: 'https://rocksky.app',
  },
  credentials: 'bundled',
  defaultRoles: {
    scrobble: true,
    enrichmentEligible: false,
  },
  staticCapabilities: {
    scrobble: true,
    nowPlaying: false,
  },
  authStrategy: 'api_key_only',
  fields: [
    {
      name: 'token',
      labelKey: 'musicNetwork.fields.rockskySessionKey',
      helpKey: 'musicNetwork.fields.rockskySessionKeyHelp',
      type: 'password',
      required: true,
    },
  ],
};

export const rockskyPreset: BuiltinPreset = {
  manifest,
  bundled: { apiKey: ROCKSKY_API_KEY, apiSecret: ROCKSKY_API_SECRET },
};
