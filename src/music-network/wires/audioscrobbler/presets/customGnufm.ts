// Custom GNU FM — user-hosted Audioscrobbler v2 / GNU FM instance.
//
// The user supplies their own origin plus API key and secret. GNU FM implements
// the Last.fm 2.0 API, so it reuses the Audioscrobbler wire with the token-poll
// flow (authBase derived from the origin by the runtime). Enrichment eligibility
// is left on but the connect probe decides what the instance actually supports;
// the UI degrades gracefully if enrichment is unavailable.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'custom_gnufm',
  wireId: 'audioscrobbler_v2',
  displayName: 'Custom GNU FM',
  descriptionKey: 'musicNetwork.presets.customGnufm.desc',
  icon: 'custom',
  category: 'custom',
  selfHostedApiSuffix: '/2.0/',
  credentials: 'user_full',
  defaultRoles: {
    scrobble: true,
    enrichmentEligible: true,
  },
  staticCapabilities: {
    scrobble: true,
    nowPlaying: true,
  },
  authStrategy: 'token_poll',
  fields: [
    {
      name: 'baseUrl',
      labelKey: 'musicNetwork.fields.gnufmUrl',
      type: 'url',
      required: true,
      placeholder: 'https://gnufm.example.com',
    },
    {
      name: 'apiKey',
      labelKey: 'musicNetwork.fields.apiKey',
      type: 'text',
      required: true,
    },
    {
      name: 'apiSecret',
      labelKey: 'musicNetwork.fields.apiSecret',
      type: 'password',
      required: true,
    },
  ],
};

export const customGnufmPreset: BuiltinPreset = { manifest };
