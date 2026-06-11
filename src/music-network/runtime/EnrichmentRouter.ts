// Resolves the single enrichment primary to its EnrichmentWire + context.
//
// Returns null unless the primary account maps to a wire that actually
// implements enrichment. Maloja / ListenBrainz wires report
// supportsEnrichment=false, so they can never drive love/similar/stats even if
// somehow set as primary — the type guard rejects them here, and the facade
// additionally refuses to set a non-eligible account as primary.

import type { PersistedAccount } from '../core/accounts';
import type { EnrichmentWire } from '../contracts/EnrichmentWire';
import { isEnrichmentWire } from '../contracts/EnrichmentWire';
import type { WireContext } from '../contracts/ScrobbleWire';
import { getWire } from '../registry/wireRegistry';
import { resolveWireContext } from './contextResolver';

export interface ResolvedEnrichment {
  wire: EnrichmentWire;
  ctx: WireContext;
}

export function resolveEnrichment(
  primary: PersistedAccount | undefined,
): ResolvedEnrichment | null {
  if (!primary) return null;
  const wire = getWire(primary.wireId);
  if (!wire || !isEnrichmentWire(wire)) return null;
  return { wire, ctx: resolveWireContext(primary) };
}
