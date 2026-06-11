// Music Network — PresetManifest contract.
//
// A preset is a declarative, data-only description of a built-in provider:
// endpoints, bundled-vs-user credentials, default roles, static capabilities,
// auth strategy, and the UI fields/warnings the Integrations section renders.
//
// Adding a provider = a new manifest file + a registry entry. No edits to the
// orchestrator, playback hooks, or the Integrations shell.

import type { CapabilityId } from '../core/capabilities';
import type { PresetId, WireId } from '../core/types';

export type PresetIcon = 'lastfm' | 'librefm' | 'rocksky' | 'maloja' | 'listenbrainz' | 'koito' | 'custom';

export type PresetCategory = 'public_audioscrobbler' | 'public_listenbrainz' | 'self_hosted' | 'custom';

/** Where credentials come from. */
export type CredentialMode =
  | 'bundled' // app-registered api key+secret, no user input
  | 'user_api_key' // user supplies a key/token (e.g. Maloja key, LB token)
  | 'user_full'; // user supplies url + key + secret (custom GNU FM)

export type AuthStrategyId = 'token_poll' | 'callback' | 'api_key_only';

/** A connect-form field rendered by the Integrations sub-UI. */
export interface PresetField {
  /** Key written into ConnectContext.fields / account.customFields. */
  name: 'baseUrl' | 'apiKey' | 'apiSecret' | 'token' | (string & {});
  /** i18n key for the label. */
  labelKey: string;
  /** Optional i18n key for a help/instructions hint shown below the field. */
  helpKey?: string;
  type: 'text' | 'password' | 'url' | 'select';
  required: boolean;
  placeholder?: string;
  /** For `type: 'select'`. */
  options?: Array<{ value: string; labelKey: string }>;
}

export type PresetWarningId = 'maloja_lastfm_proxy';

export interface PresetManifest {
  presetId: PresetId;
  wireId: WireId;
  displayName: string;
  descriptionKey: string;
  icon: PresetIcon;
  category: PresetCategory;

  endpoints?: {
    /** Trailing slash required for the Libre.fm / GNU FM family. */
    apiBase?: string;
    authBase?: string;
    profileBase?: string;
  };

  /**
   * For self-hosted presets: path appended to the user-supplied origin to form
   * the API base (e.g. '/apis/listenbrainz', '/apis/audioscrobbler'). The wire
   * then appends its own method path. Absent for fixed-host presets.
   */
  selfHostedApiSuffix?: string;

  credentials: CredentialMode;

  defaultRoles: {
    scrobble: boolean;
    enrichmentEligible: boolean;
  };

  staticCapabilities: Partial<Record<CapabilityId, boolean>>;
  authStrategy: AuthStrategyId;

  fields: PresetField[];
  warnings?: PresetWarningId[];
}
