// Probes an account's capabilities on connect.
//
// The wire probes the dynamic surface (session validity, enrichment), then the
// preset manifest's staticCapabilities are applied as the final authority for
// the keys they declare. This is how two presets on the same wire diverge — e.g.
// Rocksky declares nowPlaying:false, overriding the Audioscrobbler wire's
// optimistic nowPlaying:yes.

import type { CapabilityId, CapabilitySet } from '../core/capabilities';
import type { PersistedAccount } from '../core/accounts';
import { getPreset } from '../registry/presetRegistry';
import { requireWire } from '../registry/wireRegistry';
import { resolveWireContext } from './contextResolver';

export async function probeAccount(account: PersistedAccount): Promise<CapabilitySet> {
  const wire = requireWire(account.wireId);
  const probed = await wire.probe(resolveWireContext(account));

  const merged: CapabilitySet = { ...probed };
  const staticCaps = getPreset(account.presetId)?.manifest.staticCapabilities ?? {};
  for (const key of Object.keys(staticCaps) as CapabilityId[]) {
    merged[key] = { status: staticCaps[key] ? 'yes' : 'no' };
  }
  return merged;
}
