import type {
  CapabilityCallRoute,
  CapabilityContext,
  CapabilityDefinition,
  CapabilityStatus,
  CapabilityStrategy,
  ProbeOutcome,
  ResolvedCapability,
  StrategyDetection,
} from './types';

/** Strategies eligible for this server, strongest first. */
export function eligibleStrategies(
  def: CapabilityDefinition,
  ctx: CapabilityContext,
): CapabilityStrategy[] {
  return def.strategies
    .filter((s) => s.when(ctx))
    .sort((a, b) => b.priority - a.priority);
}

/** The single strategy that owns this feature on the connected server. */
export function pickStrategy(
  def: CapabilityDefinition,
  ctx: CapabilityContext,
): CapabilityStrategy | null {
  return eligibleStrategies(def, ctx)[0] ?? null;
}

/** Probe ids that need running for the selected strategy of each catalog feature. */
export function neededProbeIds(
  catalog: CapabilityDefinition[],
  ctx: CapabilityContext,
): Set<string> {
  const ids = new Set<string>();
  for (const def of catalog) {
    const strategy = pickStrategy(def, ctx);
    if (strategy) ids.add(strategy.detection.probeId);
  }
  return ids;
}

export function detectionStatus(
  detection: StrategyDetection,
  outcome: ProbeOutcome | undefined,
): CapabilityStatus {
  if (!outcome) return 'unknown';
  if (outcome.status === 'probing') return 'probing';
  if (outcome.status === 'error') return 'error';
  if (detection.kind === 'extension') {
    if (outcome.status !== 'present') return 'absent';
    return (outcome.extensions ?? []).includes(detection.extension) ? 'present' : 'absent';
  }
  return detection.presentWhen(outcome) ? 'present' : 'absent';
}

/** Resolve a feature's current state from catalog + probe outcomes. */
export function resolveCapability(
  def: CapabilityDefinition,
  ctx: CapabilityContext,
  probes: Record<string, ProbeOutcome | undefined>,
): ResolvedCapability {
  const strategy = pickStrategy(def, ctx);
  if (!strategy) {
    return { feature: def.feature, strategyId: null, status: 'ineligible', trust: null, activation: null };
  }
  const outcome = probes[strategy.detection.probeId];
  return {
    feature: def.feature,
    strategyId: strategy.id,
    status: detectionStatus(strategy.detection, outcome),
    trust: strategy.trust,
    activation: strategy.activation,
  };
}

/**
 * Whether a resolved feature is effectively on. Auto features follow detection;
 * manual features follow the user opt-in unless detection proves them absent.
 */
export function isCapabilityActive(resolved: ResolvedCapability, userOptIn: boolean): boolean {
  if (resolved.strategyId === null || resolved.status === 'ineligible') return false;
  if (resolved.activation === 'auto') return resolved.status === 'present';
  if (resolved.status === 'absent') return false;
  return userOptIn;
}

/**
 * Ordered call routes for an operation: strongest strategy first. A strategy is
 * included when its detection is present, or when it is marked `alwaysCallable`
 * (legacy fallback). Enables prefer-new-then-fallback routing.
 */
export function resolveCallChain(
  def: CapabilityDefinition,
  ctx: CapabilityContext,
  probes: Record<string, ProbeOutcome | undefined>,
  op: string,
): CapabilityCallRoute[] {
  const routes: CapabilityCallRoute[] = [];
  for (const strategy of eligibleStrategies(def, ctx)) {
    const call = strategy.calls[op];
    if (!call) continue;
    const status = detectionStatus(strategy.detection, probes[strategy.detection.probeId]);
    if (status === 'present' || strategy.alwaysCallable) {
      routes.push({ strategyId: strategy.id, endpoint: call.endpoint, transport: call.transport });
    }
  }
  return routes;
}
