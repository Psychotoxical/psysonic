import type { SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';

export type Semver = [number, number, number];

/**
 * Derived view of a connected server used by capability strategies to decide
 * eligibility. Built once from the `ping` identity (see `context.ts`).
 */
export interface CapabilityContext {
  identity: SubsonicServerIdentity | undefined;
  isNavidrome: boolean;
  openSubsonic: boolean;
  version: Semver | null;
  /** True when the connected server version is ≥ `min` (false when unknown). */
  semverGte(min: Semver): boolean;
}

/** Raw outcome of a single probe (one network question against the server). */
export type ProbeStatus = 'probing' | 'present' | 'absent' | 'error';

export interface ProbeOutcome {
  status: ProbeStatus;
  /** OpenSubsonic extension names, for `extension`-kind detectors to read. */
  extensions?: string[];
}

export type FeatureTrust = 'high' | 'low';
export type FeatureActivation = 'auto' | 'manual';

/** How a strategy decides it is actually available on the connected server. */
export type StrategyDetection =
  | { kind: 'extension'; probeId: string; extension: string }
  | { kind: 'functional'; probeId: string; presentWhen: (outcome: ProbeOutcome) => boolean };

/** A concrete API route a strategy can serve for a named operation. */
export interface CapabilityCall {
  /** Subsonic REST endpoint, e.g. `getSonicSimilarTracks.view`. */
  endpoint: string;
  transport: 'subsonic' | 'opensubsonic';
}

/**
 * One way to provide a feature on a given server generation. Higher `priority`
 * wins when several strategies are eligible for the same server.
 */
export interface CapabilityStrategy {
  id: string;
  priority: number;
  /** Eligible for the connected server type/version. */
  when: (ctx: CapabilityContext) => boolean;
  detection: StrategyDetection;
  trust: FeatureTrust;
  activation: FeatureActivation;
  /** Operations this strategy can serve, keyed by operation name. */
  calls: Record<string, CapabilityCall>;
  /**
   * Callable as a fallback even when detection is not satisfied — e.g. legacy
   * `getSimilarSongs` still answers via Last.fm / local agents.
   */
  alwaysCallable?: boolean;
  labelKey: string;
}

export interface CapabilityDefinition {
  feature: string;
  labelKey: string;
  /** Shorter label for inline header badges in Settings → Servers. */
  badgeLabelKey?: string;
  strategies: CapabilityStrategy[];
}

export type CapabilityStatus =
  | 'ineligible'
  | 'unknown'
  | 'probing'
  | 'present'
  | 'absent'
  | 'error';

/** Resolved per-server state for one feature, derived from catalog + probes. */
export interface ResolvedCapability {
  feature: string;
  strategyId: string | null;
  status: CapabilityStatus;
  trust: FeatureTrust | null;
  activation: FeatureActivation | null;
}

/** An ordered call route returned by the router for a feature operation. */
export interface CapabilityCallRoute {
  strategyId: string;
  endpoint: string;
  transport: 'subsonic' | 'opensubsonic';
}
