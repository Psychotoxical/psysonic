import type { PresetIcon } from '@/music-network';
import { useEnrichmentPrimary } from './useEnrichmentPrimary';

/**
 * Manifest icon id of the current enrichment-primary provider, or null when no
 * primary is set. Use it to render the love affordance with the active
 * provider's glyph (via `renderPresetIcon`) so the love button is never
 * hardcoded to one provider's logo.
 */
export function useEnrichmentPrimaryIcon(): PresetIcon | null {
  return useEnrichmentPrimary()?.icon ?? null;
}
