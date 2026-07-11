import { listen } from '@tauri-apps/api/event';
import { audioDefaultOutputDeviceName } from '@/lib/api/audio';
import { useAuthStore } from '@/store/authStore';
import { useEqStore, type EqSnapshot } from '@/store/eqStore';

/** Key used when no specific device is selected and the OS default is unknown. */
const DEFAULT_DEVICE_KEY = '__default__';

let resolvedOsDefault: string | null = null;
// The device key currently in effect. Updated on every device change.
let currentKey = DEFAULT_DEVICE_KEY;
// Suppress the mirror subscription while we programmatically apply a saved
// snapshot (on a device switch or at startup), so applying a profile does not
// immediately write it straight back.
let applying = false;

function resolveEqKey(pinnedDevice: string | null): string {
  if (pinnedDevice !== null) return pinnedDevice;
  return resolvedOsDefault ?? DEFAULT_DEVICE_KEY;
}

/** Pre-#1233 profiles lived under `__default__`; keep as read fallback on upgrade. */
function lookupSnapshot(
  byDevice: Record<string, EqSnapshot>,
  key: string,
  followingSystemDefault: boolean,
): EqSnapshot | undefined {
  if (byDevice[key]) return byDevice[key];
  if (
    followingSystemDefault &&
    key !== DEFAULT_DEVICE_KEY &&
    byDevice[DEFAULT_DEVICE_KEY]
  ) {
    return byDevice[DEFAULT_DEVICE_KEY];
  }
  return undefined;
}

function applySnapshot(snap: EqSnapshot): void {
  applying = true;
  try {
    useEqStore.getState().applySnapshot(snap);
  } finally {
    applying = false;
  }
}

function switchEqToKey(newKey: string, followingSystemDefault: boolean): void {
  if (newKey === currentKey) return;
  currentKey = newKey;
  const eq = useEqStore.getState();
  if (!eq.rememberPerDevice) return;
  const snap = lookupSnapshot(eq.byDevice, newKey, followingSystemDefault);
  if (snap) applySnapshot(snap);
  // No saved profile for this device → keep the current EQ as-is; the next
  // edit mirrors it under this device's key.
}

async function queryOsDefault(): Promise<string | null> {
  try {
    return await audioDefaultOutputDeviceName();
  } catch {
    return null;
  }
}

async function refreshFollowingSystemDefault(): Promise<void> {
  if (useAuthStore.getState().audioOutputDevice !== null) return;
  resolvedOsDefault = await queryOsDefault();
  if (useAuthStore.getState().audioOutputDevice !== null) return;
  switchEqToKey(resolveEqKey(null), true);
}

/**
 * Per-device EQ memory. Opt-in via `eqStore.rememberPerDevice` (default off);
 * while off, every branch below returns early so behaviour is unchanged.
 *
 * Keeps the equalizer profile (bands, enabled, pre-gain, active preset) for
 * each audio output device and restores it automatically when the device
 * changes. Device identity is the canonical device-name string already held in
 * `authStore.audioOutputDevice` (null = follow the active system default,
 * resolved via `audioDefaultOutputDeviceName` and refreshed on
 * `audio:device-changed` / `audio:device-reset`). Pinned devices use the same
 * name key as the device-selection feature. The audio backend exposes no stable
 * device UUID, so this deliberately inherits that feature's identity model.
 *
 * Returns a cleanup that removes all subscriptions (StrictMode-safe via
 * `initAudioListeners`).
 */
export function setupEqDeviceSync(): () => void {
  const eventUnsubs: Array<() => void> = [];
  let cancelled = false;

  const pinnedAtStart = useAuthStore.getState().audioOutputDevice;
  currentKey = resolveEqKey(pinnedAtStart);

  void (async () => {
    if (pinnedAtStart === null) {
      resolvedOsDefault = await queryOsDefault();
      if (cancelled) return;
      currentKey = resolveEqKey(null);
    }
    const eqAtStart = useEqStore.getState();
    if (eqAtStart.rememberPerDevice) {
      const snap = lookupSnapshot(
        eqAtStart.byDevice,
        currentKey,
        pinnedAtStart === null,
      );
      if (snap) applySnapshot(snap);
    }
  })();

  // Sub 1 — pinned device changed (picker or audio:device-reset clearing pin).
  const unsubDevice = useAuthStore.subscribe((_state, prev) => {
    if (_state.audioOutputDevice === prev.audioOutputDevice) return;
    void (async () => {
      const pinned = useAuthStore.getState().audioOutputDevice;
      if (pinned === null) {
        resolvedOsDefault = await queryOsDefault();
      }
      if (cancelled) return;
      const latestPinned = useAuthStore.getState().audioOutputDevice;
      switchEqToKey(resolveEqKey(latestPinned), latestPinned === null);
    })();
  });

  // Sub 2 — system default output changed externally (Rust device-watcher).
  for (const ev of ['audio:device-changed', 'audio:device-reset'] as const) {
    void listen(ev, () => {
      void refreshFollowingSystemDefault();
    }).then((u) => {
      if (cancelled) u();
      else eventUnsubs.push(u);
    });
  }

  // Sub 3 — mirror live EQ edits into the current device's snapshot, and seed
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
    cancelled = true;
    unsubDevice();
    unsubEq();
    for (const u of eventUnsubs) u();
  };
}
