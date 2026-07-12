// Music Network UI — hooks and icons. Import from here, not the root barrel,
// so runtime/store boot paths never pull lucide-react through a side-effect cycle.

export { useEnrichmentPrimary, type EnrichmentPrimary } from './useEnrichmentPrimary';
export { useEnrichmentPrimaryIcon } from './useEnrichmentPrimaryIcon';
export { useEnrichmentPrimaryLabel } from './useEnrichmentPrimaryLabel';
export { renderPresetIcon } from './presetIcon';
export { default as MusicNetworkIndicator } from './MusicNetworkIndicator';
