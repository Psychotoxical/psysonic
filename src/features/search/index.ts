/**
 * Search feature — the live search dropdown, the mobile search overlay, the
 * search/browse page (lazy via the deep path `pages/SearchBrowsePage`), live
 * search scope UI/state, and the share-link search/queue-preview surfaces.
 *
 * The local-index query engine (`lib/library/*search*`), the shared Subsonic
 * search API, the cross-cutting `liveSearchScopeStore`, and the
 * `advancedSearch*` session/scroll state live outside this feature
 * (library-core / cross-cutting) — this feature consumes them.
 */
export { default as LiveSearch } from './components/LiveSearch';
export { default as MobileSearchOverlay } from './components/MobileSearchOverlay';
export { default as ShareQueuePreviewModal } from './components/ShareQueuePreviewModal';
export { useLiveSearchRouteScope } from './hooks/useLiveSearchRouteScope';
export { useShareQueuePreview } from './hooks/useShareQueuePreview';
