// Maloja (Audioscrobbler) — {url}/apis/audioscrobbler, scrobble destination only.
//
// Maloja's /apis/audioscrobbler is its GNU FM / Last.fm 2.0-compatible endpoint
// (the older Audioscrobbler 1.2 submission protocol lives separately at
// /apis/audioscrobbler_legacy). So this preset reuses the Audioscrobbler v2 wire
// pointed at the user's Maloja origin + the compat suffix, with the Maloja API
// key pasted as the session key ("any API key as the password"). Maloja does not
// expose now-playing here, so nowPlaying is statically false. The two other
// Maloja modes (native JSON, ListenBrainz) are usually the simpler choice — this
// covers setups that only enable the Audioscrobbler surface.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'maloja_compat',
  wireId: 'audioscrobbler_v2',
  displayName: 'Maloja (Audioscrobbler API)',
  descriptionKey: 'musicNetwork.presets.malojaCompat.desc',
  icon: 'maloja',
  category: 'self_hosted',
  selfHostedApiSuffix: '/apis/audioscrobbler',
  credentials: 'user_api_key',
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
      name: 'baseUrl',
      labelKey: 'musicNetwork.fields.malojaUrl',
      type: 'url',
      required: true,
      placeholder: 'https://maloja.example.com',
    },
    {
      name: 'token',
      labelKey: 'musicNetwork.fields.malojaKey',
      type: 'password',
      required: true,
    },
  ],
};

export const malojaCompatPreset: BuiltinPreset = { manifest };
