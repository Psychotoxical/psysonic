import { useAuthStore } from '@/store/authStore';

/**
 * The one active track-transition behaviour. These are mutually exclusive —
 * only one can be on at a time.
 *
 * AutoDJ has no dedicated persisted flag: it is crossfade with content-driven
 * silence trimming (`crossfadeTrimSilence`). Keeping it encoded on the existing
 * flags avoids a state migration and leaves the audio engine — which reads the
 * three flags below directly — untouched.
 */
export type TransitionMode = 'none' | 'gapless' | 'crossfade' | 'autodj';

/** The persisted flags that together encode the active transition mode. */
export interface TransitionFlags {
  gaplessEnabled: boolean;
  crossfadeEnabled: boolean;
  crossfadeTrimSilence: boolean;
}

/**
 * Derive the single active mode from the persisted flags. Total by design —
 * gapless wins if both gapless and crossfade are somehow set (the UI never
 * produces that, but the getter must not return `undefined`).
 */
export function getTransitionMode(flags: TransitionFlags): TransitionMode {
  if (flags.gaplessEnabled) return 'gapless';
  if (flags.crossfadeEnabled) return flags.crossfadeTrimSilence ? 'autodj' : 'crossfade';
  return 'none';
}

/**
 * Flag combination for a mode — the single source of truth for "only one
 * active". `crossfadeSecs` is intentionally not touched here so switching
 * between classic crossfade and AutoDJ (and back) preserves the user's chosen
 * duration.
 */
export function transitionFlagsFor(mode: TransitionMode): TransitionFlags {
  switch (mode) {
    case 'gapless':
      return { gaplessEnabled: true, crossfadeEnabled: false, crossfadeTrimSilence: false };
    case 'crossfade':
      return { gaplessEnabled: false, crossfadeEnabled: true, crossfadeTrimSilence: false };
    case 'autodj':
      return { gaplessEnabled: false, crossfadeEnabled: true, crossfadeTrimSilence: true };
    case 'none':
    default:
      return { gaplessEnabled: false, crossfadeEnabled: false, crossfadeTrimSilence: false };
  }
}

/**
 * Apply a transition mode atomically, enforcing exclusivity in one place.
 * Replaces the scattered `setGaplessEnabled(false)` / `setCrossfadeEnabled(...)`
 * / `setCrossfadeTrimSilence(...)` combinations across the queue toolbar, mini
 * player and settings.
 */
export function setTransitionMode(mode: TransitionMode): void {
  useAuthStore.setState(transitionFlagsFor(mode));
}
