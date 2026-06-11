import { useAuthStore } from '../store/authStore';
import { getPreset, type PresetIcon } from '../music-network';

/**
 * Manifest icon id of the current enrichment-primary provider, or null when no
 * primary is set. Use it to render the love affordance with the active
 * provider's glyph (via `renderPresetIcon`) so the love button is never
 * hardcoded to one provider's logo.
 */
export function useEnrichmentPrimaryIcon(): PresetIcon | null {
  return useAuthStore(s => {
    const primary = s.musicNetworkAccounts.find(a => a.id === s.enrichmentPrimaryId);
    return primary ? getPreset(primary.presetId)?.manifest.icon ?? null : null;
  });
}
