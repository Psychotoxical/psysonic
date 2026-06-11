// Maloja native — {url}/apis/mlj_1, scrobble destination only.
//
// Posts the flat newscrobble JSON. No now-playing endpoint exists, so nowPlaying
// is statically false. baseUrl is the user's Maloja origin (the wire appends the
// /apis/mlj_1 method path). Auth key is the pasted Maloja API key.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'maloja_native',
  wireId: 'maloja_native',
  displayName: 'Maloja',
  descriptionKey: 'musicNetwork.presets.malojaNative.desc',
  icon: 'maloja',
  category: 'self_hosted',
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

export const malojaNativePreset: BuiltinPreset = { manifest };
