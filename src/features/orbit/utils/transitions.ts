import { useAuthStore } from '@/store/authStore';
import type { OrbitTransitionSettings } from '@/features/orbit/api/orbit';
import {
  sanitizeAutodjOverlapCapMode,
  sanitizeAutodjOverlapCapSec,
} from '@/lib/audio/autodjOverlapCap';

/**
 * Bridge between the local playback-transition settings (in `authStore`) and
 * the `OrbitTransitionSettings` mirrored through a session.
 *
 * Applying a set via `setState` is enough to reach the Rust engine: the
 * `authSyncListener` subscribes to `authStore` and re-pushes
 * `audio_set_crossfade` / `audio_set_gapless` on every change, and the
 * JS-side readers (`crossfadePreload`, smooth-skip) read the fields live. So
 * we deliberately reuse that path instead of invoking the audio commands here.
 */

const FIELDS = [
  'crossfadeEnabled',
  'crossfadeSecs',
  'crossfadeTrimSilence',
  'autodjSmoothSkip',
  'gaplessEnabled',
] as const;

/** Snapshot the local transition settings into an `OrbitTransitionSettings`. */
export function readOrbitTransitionSettings(): OrbitTransitionSettings {
  const s = useAuthStore.getState();
  return {
    crossfadeEnabled: s.crossfadeEnabled,
    crossfadeSecs: s.crossfadeSecs,
    crossfadeTrimSilence: s.crossfadeTrimSilence,
    autodjSmoothSkip: s.autodjSmoothSkip,
    gaplessEnabled: s.gaplessEnabled,
    autodjOverlapCapMode: s.autodjOverlapCapMode,
    autodjOverlapCapSec: s.autodjOverlapCapSec,
  };
}

/** True when the local settings already equal `t` (nothing to apply). */
function alreadyInSync(t: OrbitTransitionSettings): boolean {
  const s = useAuthStore.getState();
  if (!FIELDS.every(f => s[f] === t[f])) return false;
  if (t.autodjOverlapCapMode !== undefined
    && s.autodjOverlapCapMode !== sanitizeAutodjOverlapCapMode(t.autodjOverlapCapMode)) {
    return false;
  }
  if (t.autodjOverlapCapSec !== undefined
    && s.autodjOverlapCapSec !== sanitizeAutodjOverlapCapSec(t.autodjOverlapCapSec)) {
    return false;
  }
  return true;
}

/**
 * Apply a transition set to the local settings. No-op when already in sync, so
 * a guest can call this every read tick without churning `setState` or
 * re-firing the audio-engine sync.
 */
export function applyOrbitTransitionSettings(t: OrbitTransitionSettings): void {
  if (alreadyInSync(t)) return;
  useAuthStore.setState({
    crossfadeEnabled: t.crossfadeEnabled,
    crossfadeSecs: t.crossfadeSecs,
    crossfadeTrimSilence: t.crossfadeTrimSilence,
    autodjSmoothSkip: t.autodjSmoothSkip,
    gaplessEnabled: t.gaplessEnabled,
    ...(t.autodjOverlapCapMode !== undefined
      ? { autodjOverlapCapMode: sanitizeAutodjOverlapCapMode(t.autodjOverlapCapMode) }
      : {}),
    ...(t.autodjOverlapCapSec !== undefined
      ? { autodjOverlapCapSec: sanitizeAutodjOverlapCapSec(t.autodjOverlapCapSec) }
      : {}),
  });
}

// Guest-side snapshot of the user's own settings, kept across hook remounts so
// leave/restore is reliable even if the session bar unmounts mid-session.
let guestSaved: OrbitTransitionSettings | null = null;

/**
 * Guest: save the user's own transition settings before adopting the host's.
 * Idempotent — a second call without an intervening restore is a no-op, so the
 * per-tick host apply can never overwrite the real snapshot with host values.
 */
export function saveGuestTransitionsOnce(): void {
  if (guestSaved) return;
  guestSaved = readOrbitTransitionSettings();
}

/** Guest: restore the saved settings (if any) and clear the snapshot. */
export function restoreGuestTransitions(): void {
  if (!guestSaved) return;
  const saved = guestSaved;
  guestSaved = null;
  applyOrbitTransitionSettings(saved);
}

/** Test-only: whether a guest snapshot is currently held. */
export function hasGuestTransitionsSnapshot(): boolean {
  return guestSaved !== null;
}
