import { useAuthStore } from '../store/authStore';

/**
 * Display label of the current enrichment-primary account (e.g. "Last.fm",
 * "Libre.fm"), or null when no primary is set. Use this for any user-facing
 * "love / stats come from <provider>" copy so the UI never hardcodes a single
 * provider name — the primary can be any enrichment-eligible service.
 */
export function useEnrichmentPrimaryLabel(): string | null {
  return useAuthStore(
    s => s.musicNetworkAccounts.find(a => a.id === s.enrichmentPrimaryId)?.label ?? null,
  );
}
