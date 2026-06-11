import { useMemo } from 'react';
import { useAuthStore } from '../../store/authStore';
import { getPreset } from '../registry/presetRegistry';
import type { PersistedAccount } from '../core/accounts';
import type { PresetIcon } from '../contracts/PresetManifest';

export interface EnrichmentPrimary {
  account: PersistedAccount;
  /** Display label (e.g. "Last.fm", "Libre.fm"). */
  label: string;
  /** Manifest icon id of the provider, for `renderPresetIcon`. */
  icon: PresetIcon;
}

/**
 * The single enrichment-primary account (drives love / similar / stats) plus its
 * display label and provider icon, or null when no primary is set.
 *
 * One lookup for the whole app — indicator, player bar, hero, stats, and the
 * context menus all go through here so nothing re-derives the account or
 * hardcodes a provider name/icon (provider-agnostic, spec §7.3). The icon falls
 * back to the neutral 'custom' glyph, never to a specific provider.
 */
export function useEnrichmentPrimary(): EnrichmentPrimary | null {
  const account = useAuthStore(
    s => s.musicNetworkAccounts.find(a => a.id === s.enrichmentPrimaryId),
  );
  return useMemo(() => {
    if (!account) return null;
    return {
      account,
      label: account.label,
      icon: getPreset(account.presetId)?.manifest.icon ?? 'custom',
    };
  }, [account]);
}
