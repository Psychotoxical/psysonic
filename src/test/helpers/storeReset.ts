/**
 * Per-test Zustand store reset helpers.
 *
 * Zustand stores are module-level singletons and leak state across tests
 * unless explicitly reset. setup.ts already clears localStorage between
 * tests, but the in-memory `getState()` snapshot survives — a mutation in
 * test A is visible to test B unless we reset.
 *
 * Strategy: capture each store's initial state at module-import time (when
 * persist hydration runs against the empty MemoryStorage polyfill in
 * setup.ts, so we get the static defaults). Each reset replaces the live
 * state with that captured snapshot, preserving the original action
 * references (functions are stable across `setState` since they're closed
 * over `set`/`get` from the original factory call).
 *
 * Usage in a test file:
 *
 *   import { resetPlayerStore, resetAllStores } from '@/test/helpers/storeReset';
 *   beforeEach(resetPlayerStore);
 *   // or for cross-store tests:
 *   beforeEach(resetAllStores);
 */
import { usePlayerStore, _resetQueueUndoStacksForTest } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { usePreviewStore } from '@/store/previewStore';
import { useOrbitStore } from '@/store/orbitStore';

const INITIAL_PLAYER_STATE = usePlayerStore.getState();
const INITIAL_AUTH_STATE = useAuthStore.getState();
const INITIAL_PREVIEW_STATE = usePreviewStore.getState();
const INITIAL_ORBIT_STATE = useOrbitStore.getState();

export function resetPlayerStore(): void {
  usePlayerStore.setState(INITIAL_PLAYER_STATE, true);
  // Module-scoped queue undo/redo stacks live outside the Zustand state.
  _resetQueueUndoStacksForTest();
}

export function resetAuthStore(): void {
  useAuthStore.setState(INITIAL_AUTH_STATE, true);
}

export function resetPreviewStore(): void {
  usePreviewStore.setState(INITIAL_PREVIEW_STATE, true);
}

export function resetOrbitStore(): void {
  useOrbitStore.setState(INITIAL_ORBIT_STATE, true);
}

export function resetAllStores(): void {
  resetPlayerStore();
  resetAuthStore();
  resetPreviewStore();
  resetOrbitStore();
}
