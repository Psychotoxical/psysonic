import {
  isNavidromeServer,
  parseLeadingSemver,
  type SubsonicServerIdentity,
} from '@/lib/server/subsonicServerIdentity';
import type { CapabilityContext, Semver } from './types';

function semverGte(a: Semver, b: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/** Build the eligibility context for a connected server from its `ping` identity. */
export function buildCapabilityContext(identity: SubsonicServerIdentity | undefined): CapabilityContext {
  const version = parseLeadingSemver(identity?.serverVersion);
  return {
    identity,
    isNavidrome: isNavidromeServer(identity),
    openSubsonic: !!identity?.openSubsonic,
    version,
    semverGte: (min) => (version ? semverGte(version, min) : false),
  };
}
