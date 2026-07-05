import { useAuthStore } from '@/store/authStore';
import type {
  InstantMixProbeResult,
} from '@/lib/server/subsonicServerIdentity';
import { buildCapabilityContext } from './context';
import {
  PROBE_LEGACY_INSTANT_MIX,
  PROBE_OPENSUBSONIC_EXTENSIONS,
  SONIC_SIMILARITY_EXTENSION,
  getCapabilityDefinition,
} from './catalog';
import {
  isCapabilityActive,
  resolveCallChain,
  resolveCapability,
} from './resolve';
import type {
  CapabilityCallRoute,
  ProbeOutcome,
  ResolvedCapability,
} from './types';

/**
 * Probe results currently live in dedicated per-server store maps. This facade
 * maps them into the generic `ProbeOutcome` shape the resolver consumes, so the
 * catalog/resolver/router stay storage-agnostic.
 *
 * The OpenSubsonic extensions outcome is built from the full advertised list
 * (`openSubsonicExtensionsByServer`) so every extension-gated feature reads from
 * one source. The AudioMuse `sonicSimilarity` probe lifecycle still supplies the
 * probing/error transitions (it drives the fetch on Navidrome ≥ 0.62), and acts
 * as a back-compat fallback for state persisted before the list was captured.
 */
function openSubsonicExtensionsOutcome(serverId: string): ProbeOutcome | undefined {
  const s = useAuthStore.getState();
  const list = s.openSubsonicExtensionsByServer[serverId];
  if (list) return { status: 'present', extensions: list };
  const probe = s.audiomusePluginProbeByServer[serverId];
  switch (probe) {
    case 'present': return { status: 'present', extensions: [SONIC_SIMILARITY_EXTENSION] };
    case 'absent': return { status: 'present', extensions: [] };
    case 'probing': return { status: 'probing' };
    case 'error': return { status: 'error' };
    default: return undefined;
  }
}

function legacyProbeToOutcome(probe: InstantMixProbeResult | undefined): ProbeOutcome | undefined {
  switch (probe) {
    case 'ok': return { status: 'present' };
    case 'empty':
    case 'skipped': return { status: 'absent' };
    case 'error': return { status: 'error' };
    default: return undefined;
  }
}

export function buildProbeOutcomesForServer(serverId: string): Record<string, ProbeOutcome | undefined> {
  const s = useAuthStore.getState();
  return {
    [PROBE_OPENSUBSONIC_EXTENSIONS]: openSubsonicExtensionsOutcome(serverId),
    [PROBE_LEGACY_INSTANT_MIX]: legacyProbeToOutcome(s.instantMixProbeByServer[serverId]),
  };
}

export function resolveFeatureForServer(
  serverId: string,
  feature: string,
): ResolvedCapability | null {
  const def = getCapabilityDefinition(feature);
  if (!def) return null;
  const s = useAuthStore.getState();
  const ctx = buildCapabilityContext(s.subsonicServerIdentityByServer[serverId]);
  return resolveCapability(def, ctx, buildProbeOutcomesForServer(serverId));
}

export function isFeatureActiveForServer(serverId: string, feature: string): boolean {
  const resolved = resolveFeatureForServer(serverId, feature);
  if (!resolved) return false;
  const userOptIn = !!useAuthStore.getState().audiomuseNavidromeByServer[serverId];
  return isCapabilityActive(resolved, userOptIn);
}

export function resolveCallRoutesForServer(
  serverId: string,
  feature: string,
  op: string,
): CapabilityCallRoute[] {
  const def = getCapabilityDefinition(feature);
  if (!def) return [];
  const s = useAuthStore.getState();
  const ctx = buildCapabilityContext(s.subsonicServerIdentityByServer[serverId]);
  return resolveCallChain(def, ctx, buildProbeOutcomesForServer(serverId), op);
}
