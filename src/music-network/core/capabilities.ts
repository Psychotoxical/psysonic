// Music Network — capability model.
//
// Each provider account is probed on connect; the result is a CapabilitySet
// describing which features the live session actually supports. The runtime and
// UI gate features on this — never on the provider name.

export type CapabilityId =
  | 'scrobble'
  | 'nowPlaying'
  | 'love'
  | 'lovedSync'
  | 'similarArtists'
  | 'trackStats'
  | 'artistStats'
  | 'userTopLists'
  | 'recentTracks'
  | 'profileLinks';

export const ALL_CAPABILITIES: readonly CapabilityId[] = [
  'scrobble',
  'nowPlaying',
  'love',
  'lovedSync',
  'similarArtists',
  'trackStats',
  'artistStats',
  'userTopLists',
  'recentTracks',
  'profileLinks',
];

/** The enrichment-only capabilities (read features), i.e. everything past scrobbling. */
export const ENRICHMENT_CAPABILITIES: readonly CapabilityId[] = [
  'love',
  'lovedSync',
  'similarArtists',
  'trackStats',
  'artistStats',
  'userTopLists',
  'recentTracks',
  'profileLinks',
];

export type CapabilityStatus = 'yes' | 'no' | 'unknown' | 'error';

export interface CapabilityState {
  status: CapabilityStatus;
  /** Provider-supplied detail surfaced on probe error. */
  message?: string;
}

export type CapabilitySet = Partial<Record<CapabilityId, CapabilityState>>;

/**
 * Marks every enrichment capability as unsupported (`no`) on the given set and
 * returns it. Scrobble-only wires (Maloja native, ListenBrainz, paste-auth
 * Audioscrobbler presets) call this after settling scrobble/now-playing.
 */
export function markNoEnrichment(caps: CapabilitySet): CapabilitySet {
  for (const id of ENRICHMENT_CAPABILITIES) caps[id] = { status: 'no' };
  return caps;
}

/** True when the set reports at least one enrichment capability as `yes`. */
export function hasAnyEnrichment(caps: CapabilitySet): boolean {
  return ENRICHMENT_CAPABILITIES.some(id => caps[id]?.status === 'yes');
}

/** Convenience: is this specific capability usable right now? */
export function isCapable(caps: CapabilitySet, id: CapabilityId): boolean {
  return caps[id]?.status === 'yes';
}
