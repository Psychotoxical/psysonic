/**
 * Side-effect wiring (queue thin-state): keep the queue track resolver cache
 * warm around the current index whenever the canonical `queueItems` ref list or
 * the playing index changes. The store is refs-canonical now, so this fills the
 * cache (via `resolveVisibleRange` — index batch → getSong fallback) so the
 * queue selectors / list rows resolve without a synchronous miss. Render paths
 * stay pure (no cache mutation in render); the seed travels with the playing
 * track here, off the render path.
 */
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resolveVisibleRange } from '@/features/playback/store/queueTrackResolver';

usePlayerStore.subscribe((state, prev) => {
  // Re-seed when the queue refs or the current index change — the prefetch
  // window (resolveVisibleRange's PREFETCH_BACK/AHEAD) travels with the index.
  if (
    state.queueItems === prev.queueItems &&
    state.queueIndex === prev.queueIndex
  ) return;
  if (state.queueItems.length === 0) return;
  resolveVisibleRange(state.queueItems, state.queueIndex, state.queueIndex);
});
