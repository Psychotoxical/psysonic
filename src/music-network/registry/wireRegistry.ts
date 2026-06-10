// Wire registry — maps a WireId to its single wire implementation.
//
// The orchestrator and enrichment router resolve an account's wire through here;
// they never import a concrete wire. Adding a provider that needs a new protocol
// means registering one more wire — no edits to consumers.

import { MusicNetworkError } from '../core/errors';
import type { WireId } from '../core/types';
import type { ScrobbleWire } from '../contracts/ScrobbleWire';

const wires = new Map<WireId, ScrobbleWire>();

export function registerWire(wire: ScrobbleWire): void {
  wires.set(wire.wireId, wire);
}

export function getWire(wireId: WireId): ScrobbleWire | undefined {
  return wires.get(wireId);
}

export function requireWire(wireId: WireId): ScrobbleWire {
  const w = wires.get(wireId);
  if (!w) {
    throw new MusicNetworkError('PROBE_FAILED', `No wire registered for "${wireId}"`);
  }
  return w;
}

/** Test seam — drop all registrations. */
export function __resetWires(): void {
  wires.clear();
}
