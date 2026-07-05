/**
 * Device Sync feature — copies/transcodes library tracks onto external devices
 * (USB drives, players). The `DeviceSync` page is lazy-loaded by the router via
 * its deep path, so it is intentionally not re-exported here.
 *
 * Note: `audioListenerSetup/eqDeviceSync` is NOT part of this feature — it is the
 * audio-core EQ-per-output-device profile sync, kept in the audio core.
 */
export { useDeviceSyncJobStore } from './store/deviceSyncJobStore';
export type { DeviceSyncSource } from './store/deviceSyncStore';
