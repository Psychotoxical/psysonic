import { listen } from '@tauri-apps/api/event';
import {
  audioDefaultOutputDeviceName,
  audioDefaultOutputDeviceNameForPoll,
  audioMatchStoredOutputDeviceKey,
} from '@/lib/api/audio';
import { useAuthStore } from '@/store/authStore';
import { useEqStore, type EqSnapshot } from '@/store/eqStore';

/** Key used when no specific device is selected and the OS default is unknown. */
const DEFAULT_DEVICE_KEY = '__default__';
/** cpal generic alias saved before PipeWire default resolution (#1274). */
const CPAL_GENERIC_DEFAULT_KEY = 'Default Audio Device';
/** Match Rust device-watcher poll interval while following system default. */
const SYSTEM_DEFAULT_POLL_MS = 3000;

function isLegacyDefaultDeviceKey(key: string): boolean {
  return key === DEFAULT_DEVICE_KEY || key === CPAL_GENERIC_DEFAULT_KEY;
}

let resolvedOsDefault: string | null = null;
// The device key currently in effect. Updated on every device change.
let currentKey = DEFAULT_DEVICE_KEY;
// Suppress the mirror subscription while we programmatically apply a saved
// snapshot (on a device switch or at startup), so applying a profile does not
// immediately write it straight back.
let applying = false;
/** Serializes async OS-default queries so overlapping polls/events cannot apply stale EQ keys. */
const osDefaultRefreshQueue: { tail: Promise<void> } = { tail: Promise.resolve() };

function enqueueOsDefaultRefresh(task: () => Promise<void>): Promise<void> {
  const next = osDefaultRefreshQueue.tail.then(task, task);
  osDefaultRefreshQueue.tail = next.catch(() => {});
  return next;
}

function resolveEqKey(pinnedDevice: string | null): string {
  if (pinnedDevice !== null) return pinnedDevice;
  return resolvedOsDefault ?? DEFAULT_DEVICE_KEY;
}

function shouldFollowSystemDefaultEq(): boolean {
  return (
    useEqStore.getState().rememberPerDevice &&
    useAuthStore.getState().audioOutputDevice === null
  );
}

/** Pre-#1233 profiles lived under `__default__`; keep as read fallback on upgrade. */
function lookupSnapshot(
  byDevice: Record<string, EqSnapshot>,
  key: string,
  followingSystemDefault: boolean,
): EqSnapshot | undefined {
  if (byDevice[key]) return byDevice[key];
  if (!followingSystemDefault) return undefined;
  for (const legacy of [DEFAULT_DEVICE_KEY, CPAL_GENERIC_DEFAULT_KEY]) {
    if (key !== legacy && byDevice[legacy]) {
      return byDevice[legacy];
    }
  }
  return undefined;
}

async function lookupSnapshotAsync(
  byDevice: Record<string, EqSnapshot>,
  key: string,
  followingSystemDefault: boolean,
): Promise<EqSnapshot | undefined> {
  const direct = lookupSnapshot(byDevice, key, followingSystemDefault);
  if (direct) return direct;
  const storedKeys = Object.keys(byDevice);
  if (storedKeys.length === 0) return undefined;
  try {
    const matched = await audioMatchStoredOutputDeviceKey(key, storedKeys);
    if (matched && byDevice[matched]) return byDevice[matched];
  } catch {
    return undefined;
  }
  return undefined;
}

/** Serializes async pinned-device EQ switches so overlapping updates cannot apply stale snapshots. */
const pinnedSwitchQueue: { tail: Promise<void> } = { tail: Promise.resolve() };

function enqueuePinnedSwitch(task: () => Promise<void>): Promise<void> {
  const next = pinnedSwitchQueue.tail.then(task, task);
  pinnedSwitchQueue.tail = next.catch(() => {});
  return next;
}

function applySnapshot(snap: EqSnapshot): void {
  applying = true;
  try {
    useEqStore.getState().applySnapshot(snap);
  } finally {
    applying = false;
  }
}

async function switchEqToKeyAsync(
  newKey: string,
  followingSystemDefault: boolean,
): Promise<void> {
  if (!followingSystemDefault && useAuthStore.getState().audioOutputDevice !== newKey) {
    return;
  }
  const prevKey = currentKey;
  if (newKey === prevKey) return;
  const eq = useEqStore.getState();
  if (eq.rememberPerDevice) {
    eq.saveSnapshotFor(prevKey);
  }
  if (!eq.rememberPerDevice) {
    currentKey = newKey;
    return;
  }
  const snap = await lookupSnapshotAsync(eq.byDevice, newKey, followingSystemDefault);
  if (!followingSystemDefault && useAuthStore.getState().audioOutputDevice !== newKey) {
    return;
  }
  if (currentKey !== prevKey) {
    return;
  }
  currentKey = newKey;
  if (snap) {
    applySnapshot(snap);
    return;
  }
  if (followingSystemDefault && isLegacyDefaultDeviceKey(prevKey)) {
    useEqStore.getState().saveSnapshotFor(newKey);
  }
}

async function queryOsDefault(forPoll = false): Promise<string | null> {
  try {
    return forPoll
      ? await audioDefaultOutputDeviceNameForPoll()
      : await audioDefaultOutputDeviceName();
  } catch {
    return null;
  }
}

async function resolveSystemDefaultKey(forPoll = false): Promise<string | null> {
  const next = await queryOsDefault(forPoll);
  if (next !== null) {
    resolvedOsDefault = next;
    return resolveEqKey(null);
  }
  if (resolvedOsDefault !== null) {
    return resolveEqKey(null);
  }
  return null;
}

async function refreshFollowingSystemDefault(forPoll = false): Promise<void> {
  if (!shouldFollowSystemDefaultEq()) return;
  await enqueueOsDefaultRefresh(async () => {
    if (!shouldFollowSystemDefaultEq()) return;
    const key = await resolveSystemDefaultKey(forPoll);
    if (key === null) return;
    if (!shouldFollowSystemDefaultEq()) return;
    await switchEqToKeyAsync(key, true);
  });
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

  void enqueueOsDefaultRefresh(async () => {
    if (pinnedAtStart === null) {
      await resolveSystemDefaultKey();
      if (cancelled) return;
    }
    const pinned = useAuthStore.getState().audioOutputDevice;
    currentKey = resolveEqKey(pinned);
    const eqAtStart = useEqStore.getState();
    if (eqAtStart.rememberPerDevice) {
      const snap = await lookupSnapshotAsync(
        eqAtStart.byDevice,
        currentKey,
        pinned === null,
      );
      if (snap) applySnapshot(snap);
    }
  });

  // Sub 1 — pinned device changed (picker or audio:device-reset clearing pin).
  const unsubDevice = useAuthStore.subscribe((_state, prev) => {
    if (_state.audioOutputDevice === prev.audioOutputDevice) return;
    const latestPinned = _state.audioOutputDevice;
    if (latestPinned !== null) {
      void enqueuePinnedSwitch(() => switchEqToKeyAsync(latestPinned, false));
      return;
    }
    void enqueueOsDefaultRefresh(async () => {
      const key = await resolveSystemDefaultKey();
      if (cancelled) return;
      if (useAuthStore.getState().audioOutputDevice !== null) return;
      if (key === null) return;
      await switchEqToKeyAsync(key, true);
    });
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

  // Sub 3 — poll while following system default (covers missed events / wpctl lag).
  const pollId = setInterval(() => {
    if (cancelled) return;
    void refreshFollowingSystemDefault(true);
  }, SYSTEM_DEFAULT_POLL_MS);

  // Sub 4 — mirror live EQ edits into the current device's snapshot, and seed
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
    if (justEnabled) {
      void (async () => {
        const pinned = useAuthStore.getState().audioOutputDevice;
        const key = pinned ?? await resolveSystemDefaultKey() ?? DEFAULT_DEVICE_KEY;
        if (cancelled) return;
        currentKey = key;
        useEqStore.getState().saveSnapshotFor(key);
      })();
      return;
    }
    if (contentChanged) {
      useEqStore.getState().saveSnapshotFor(currentKey);
    }
  });

  return () => {
    cancelled = true;
    clearInterval(pollId);
    unsubDevice();
    unsubEq();
    for (const u of eventUnsubs) u();
  };
}
