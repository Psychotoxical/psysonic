// ListenBrainz (direct) — api.listenbrainz.org, scrobble destination only.
//
// User pastes a token from listenbrainz.org/profile. Scrobble + now playing;
// no enrichment in v1 (spec §2.3).

import type { PresetManifest } from '../../../contracts/PresetManifest';
import type { BuiltinPreset } from '../../../registry/presetTypes';

const manifest: PresetManifest = {
  presetId: 'listenbrainz',
  wireId: 'listenbrainz',
  displayName: 'ListenBrainz',
  descriptionKey: 'musicNetwork.presets.listenbrainz.desc',
  icon: 'listenbrainz',
  category: 'public_listenbrainz',
  endpoints: {
    apiBase: 'https://api.listenbrainz.org',
    profileBase: 'https://listenbrainz.org',
  },
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
      name: 'token',
      labelKey: 'musicNetwork.fields.lbToken',
      type: 'password',
      required: true,
    },
  ],
};

export const listenbrainzPreset: BuiltinPreset = { manifest };
