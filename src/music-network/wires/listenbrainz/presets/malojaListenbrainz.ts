// Maloja ListenBrainz compat — {url}/apis/listenbrainz, scrobble destination only.
//
// Same ListenBrainz wire as the direct preset; only the base URL differs (the
// user's Maloja origin plus the compat suffix). Auth token is the Maloja API key.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'maloja_listenbrainz',
  wireId: 'listenbrainz',
  displayName: 'Maloja (ListenBrainz API)',
  descriptionKey: 'musicNetwork.presets.malojaListenbrainz.desc',
  icon: 'maloja',
  category: 'self_hosted',
  selfHostedApiSuffix: '/apis/listenbrainz',
  credentials: 'user_api_key',
  defaultRoles: {
    scrobble: true,
    enrichmentEligible: false,
  },
  staticCapabilities: {
    scrobble: true,
    nowPlaying: true,
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

export const malojaListenbrainzPreset: BuiltinPreset = { manifest };
