// Probes an account's capabilities on connect.
//
// The wire probes the dynamic surface (session validity, enrichment), then the
// preset manifest's staticCapabilities refine the keys they declare. A static
// `false` is a hard "not offered" (e.g. Rocksky nowPlaying:false overrides the
// Audioscrobbler wire's optimistic nowPlaying:yes). A static `true` only affirms
// support — it must NOT mask a runtime probe `error`, so an invalid pasted token
// (whose sole validation is the probe) still surfaces as an error.

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
    if (!staticCaps[key]) {
      // Structurally not offered — hard override.
      merged[key] = { status: 'no' };
    } else if (merged[key]?.status !== 'error') {
      // Offered: affirm 'yes', but let a runtime probe 'error' stand.
      merged[key] = { status: 'yes' };
    }
  }
  return merged;
}
