// Music Network — public surface for the rest of the app.
//
// App code imports ONLY from here (or from this package root). It must never
// reach into wires/, registry/, or a provider preset directly.

export { MusicNetworkRuntime, type ConnectOptions } from './runtime/MusicNetworkRuntime';
export {
  getMusicNetworkRuntime,
  getMusicNetworkRuntimeOrNull,
  initMusicNetworkRuntime,
} from './runtime/getMusicNetworkRuntime';
export type { MusicNetworkStore, RuntimeHost } from './runtime/store';
export { listPresets, getPreset } from './registry/presetRegistry';
export { useEnrichmentPrimary, type EnrichmentPrimary } from './ui/useEnrichmentPrimary';
export { useEnrichmentPrimaryIcon } from './ui/useEnrichmentPrimaryIcon';
export { useEnrichmentPrimaryLabel } from './ui/useEnrichmentPrimaryLabel';
export { renderPresetIcon } from './ui/presetIcon';
export { default as MusicNetworkIndicator } from './ui/MusicNetworkIndicator';
export {
  migrateLegacyLastfm,
  sanitizeAccounts,
  type LegacyLastfmState,
} from './runtime/accountPersistence';

export type {
  Account,
  AccountPatch,
  AccountRoles,
  MusicNetworkState,
  PersistedAccount,
} from './core/accounts';
export type {
  CapabilityId,
  CapabilitySet,
  CapabilityState,
  CapabilityStatus,
} from './core/capabilities';
export { MusicNetworkError, errorI18nKey, isMusicNetworkError } from './core/errors';
export type { MusicNetworkErrorCode } from './core/errors';
export type {
  ArtistStats,
  PresetId,
  RecentTrack,
  ScrobbleEvent,
  StatsPeriod,
  TopItem,
  TopKind,
  TrackRef,
  TrackStats,
  UserProfile,
  WireId,
} from './core/types';
export type { PresetManifest, PresetField, PresetIcon } from './contracts/PresetManifest';
export type { BuiltinPreset } from './registry/presetTypes';
