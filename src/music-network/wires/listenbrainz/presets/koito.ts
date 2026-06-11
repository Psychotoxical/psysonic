// Koito — {url}/apis/listenbrainz, scrobble destination only.
//
// Koito is a self-hosted listening-history tracker that exposes a
// ListenBrainz-compatible submit API at {origin}/apis/listenbrainz, with an
// API key (generated in Koito's UI) used as the listen token. So it reuses the
// ListenBrainz wire — same protocol as the direct ListenBrainz and Maloja
// ListenBrainz presets, differing only by base URL and the pasted token.

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'koito',
  wireId: 'listenbrainz',
  displayName: 'Koito',
  descriptionKey: 'musicNetwork.presets.koito.desc',
  icon: 'koito',
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
      labelKey: 'musicNetwork.fields.koitoUrl',
      type: 'url',
      required: true,
      placeholder: 'https://koito.example.com',
    },
    {
      name: 'token',
      labelKey: 'musicNetwork.fields.koitoToken',
      helpKey: 'musicNetwork.fields.koitoTokenHelp',
      type: 'password',
      required: true,
    },
  ],
};

export const koitoPreset: BuiltinPreset = { manifest };
