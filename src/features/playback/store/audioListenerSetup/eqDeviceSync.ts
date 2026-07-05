import { useAuthStore } from '@/store/authStore';
import { useEqStore, type EqSnapshot } from '@/store/eqStore';

/** Key used when no specific device is selected (system default). */
const DEFAULT_DEVICE_KEY = '__default__';

function deviceKey(name: string | null): string {
  return name ?? DEFAULT_DEVICE_KEY;
}

// The device key currently in effect. Updated on every device change.
let currentKey = DEFAULT_DEVICE_KEY;
// Suppress the mirror subscription while we programmatically apply a saved
// snapshot (on a device switch or at startup), so applying a profile does not
// immediately write it straight back.
let applying = false;

function applySnapshot(snap: EqSnapshot): void {
  applying = true;
  try {
    useEqStore.getState().applySnapshot(snap);
  } finally {
    applying = false;
  }
}

/**
 * Per-device EQ memory. Opt-in via `eqStore.rememberPerDevice` (default off);
 * while off, every branch below returns early so behaviour is unchanged.
 *
 * Keeps the equalizer profile (bands, enabled, pre-gain, active preset) for
 * each audio output device and restores it automatically when the device
 * changes. Device identity is the canonical device-name string already held in
 * `authStore.audioOutputDevice` (null = system default → `__default__`) — the
 * same key the device-selection feature relies on. The audio backend exposes no
 * stable device UUID, so this deliberately inherits that feature's identity
 * model rather than inventing a weaker one.
 *
 * Returns a cleanup that removes both subscriptions (StrictMode-safe via
 * `initAudioListeners`).
 */
export function setupEqDeviceSync(): () => void {
  currentKey = deviceKey(useAuthStore.getState().audioOutputDevice);

  // Startup: restore the saved profile for the current device, if any. A no-op
  // in the common case (the persisted global EQ already equals this device's
  // mirrored snapshot); it only matters when the resolved device differs from
  // the one active at shutdown.
  const eqAtStart = useEqStore.getState();
  if (eqAtStart.rememberPerDevice) {
    const snap = eqAtStart.byDevice[currentKey];
    if (snap) applySnapshot(snap);
  }

  // Sub 1 — device changed. Covers both the explicit picker selection and the
  // `audio:device-reset` unplug event, since both flow through this field.
  const unsubDevice = useAuthStore.subscribe((state, prev) => {
    if (state.audioOutputDevice === prev.audioOutputDevice) return;
    currentKey = deviceKey(state.audioOutputDevice);
    const eq = useEqStore.getState();
    if (!eq.rememberPerDevice) return;
    const snap = eq.byDevice[currentKey];
    if (snap) applySnapshot(snap);
    // No saved profile for this device → keep the current EQ as-is; the next
    // edit mirrors it under this device's key.
  });

  // Sub 2 — mirror live EQ edits into the current device's snapshot, and seed
  // the current device when the feature is switched on. Writing `byDevice` does
  // not touch the content fields, so the re-triggered listener is a no-op (no
  // feedback loop).
  const unsubEq = useEqStore.subscribe((state, prev) => {
    if (applying) return;
    if (!state.rememberPerDevice) return;
    const justEnabled = !prev.rememberPerDevice;
    const contentChanged =
      state.gains !== prev.gains ||
      state.enabled !== prev.enabled ||
      state.preGain !== prev.preGain ||
      state.activePreset !== prev.activePreset;
    if (justEnabled || contentChanged) {
      useEqStore.getState().saveSnapshotFor(currentKey);
    }
  });

  return () => {
    unsubDevice();
    unsubEq();
  };
}
