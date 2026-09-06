import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  deviceSyncDeviceId,
  listDeviceDirFiles,
  pendingDeviceSyncPlanDeviceId,
} from '@/lib/api/syncfs';
import type { TFunction } from 'i18next';
import {
  deviceSyncManifestImport,
  deviceSyncLegacySourcesFromManifest,
  useDeviceSyncStore,
  type DeviceSyncManifest,
} from '@/features/deviceSync/store/deviceSyncStore';
import { showToast } from '@/lib/dom/toast';

export interface DeviceSyncDeviceScanResult {
  scanDevice: () => Promise<void>;
}

export function useDeviceSyncDeviceScan(
  targetDir: string | null,
  sourcesLength: number,
  driveDetected: boolean,
  t: TFunction,
  driveKey: string | null = driveDetected ? targetDir : null,
): DeviceSyncDeviceScanResult {
  const setDeviceFilePaths = useDeviceSyncStore.getState().setDeviceFilePaths;
  const setScanning        = useDeviceSyncStore.getState().setScanning;
  const targetRevision = useDeviceSyncStore(s => s.targetRevision);
  const scanRequestRef = useRef(0);
  const manifestRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [manifestRetryTick, setManifestRetryTick] = useState(0);

  const scanDevice = useCallback(async () => {
    const requestId = ++scanRequestRef.current;
    if (!targetDir || sourcesLength === 0) {
      setDeviceFilePaths([]);
      setScanning(false);
      return;
    }
    const requestTarget = targetDir;
    setScanning(true);
    try {
      const files = await listDeviceDirFiles({ dir: requestTarget });
      if (
        scanRequestRef.current === requestId &&
        useDeviceSyncStore.getState().targetDir === requestTarget
      ) setDeviceFilePaths(files);
    } catch {
      if (
        scanRequestRef.current === requestId &&
        useDeviceSyncStore.getState().targetDir === requestTarget
      ) setDeviceFilePaths([]);
    } finally {
      if (
        scanRequestRef.current === requestId &&
        useDeviceSyncStore.getState().targetDir === requestTarget
      ) setScanning(false);
    }
  }, [targetDir, sourcesLength, setDeviceFilePaths, setScanning]);

  // Scan device on mount and when targetDir changes
  useEffect(() => { scanDevice(); }, [scanDevice]);

  // Auto-import manifest when page loads and drive is already connected
  const manifestImportedDeviceRef = useRef<string | null>(null);
  const manifestRequestRef = useRef(0);
  const liveDriveKeyRef = useRef(driveKey);
  useEffect(() => {
    liveDriveKeyRef.current = driveKey;
  }, [driveKey]);
  useEffect(() => {
    if (!targetDir || !driveDetected || !driveKey) return;
    const requestTarget = targetDir;
    const requestDriveKey = driveKey;
    const importedDeviceKey = `${requestTarget}\0${requestDriveKey}`;
    if (manifestImportedDeviceRef.current === importedDeviceKey) return;
    const requestId = ++manifestRequestRef.current;
    const requestIsCurrent = () => manifestRequestRef.current === requestId
      && useDeviceSyncStore.getState().targetDir === requestTarget
      && liveDriveKeyRef.current === requestDriveKey;
    manifestImportedDeviceRef.current = importedDeviceKey;
    useDeviceSyncStore.getState().setPendingPlanChecked(false);
    invoke<DeviceSyncManifest | null>(
      'read_device_manifest', { destDir: targetDir }
    ).then(async manifest => {
      if (!requestIsCurrent()) return;
      const deviceId = await deviceSyncDeviceId({ destDir: requestTarget });
      const pendingPlanDeviceId = await pendingDeviceSyncPlanDeviceId({ destDir: requestTarget });
      if (!requestIsCurrent()) return;
      const pendingPlan = pendingPlanDeviceId !== null;
      useDeviceSyncStore.getState().setPendingPlan(pendingPlan);
      useDeviceSyncStore.getState().setPendingPlanDeviceId(pendingPlanDeviceId);
      if (!pendingPlan || useDeviceSyncStore.getState().targetDeviceId === null) {
        useDeviceSyncStore.getState().setTargetDeviceId(deviceId);
      }
      useDeviceSyncStore.getState().setPendingPlanChecked(true);
      if (pendingPlan) return;
      const legacySources = deviceSyncLegacySourcesFromManifest(manifest);
      if (legacySources.length > 0) {
        useDeviceSyncStore.getState().quarantineLegacySources(requestTarget, legacySources);
      }
      const manifestImport = deviceSyncManifestImport(manifest);
      if (manifestImport) {
        if (!requestIsCurrent()) return;
        const store = useDeviceSyncStore.getState();
        store.clearSources();
        store.setPendingPlan(pendingPlan);
        store.applyManifestConfiguration(manifestImport.layoutMode, manifestImport.playlistPathMode);
        manifestImport.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
        showToast(t('deviceSync.manifestImported', { count: manifestImport.sources.length }), 4000, 'info');
      }
    }).catch(() => {
      if (requestIsCurrent()) {
        manifestImportedDeviceRef.current = null;
        if (manifestRetryTimerRef.current) clearTimeout(manifestRetryTimerRef.current);
        manifestRetryTimerRef.current = setTimeout(() => {
          manifestRetryTimerRef.current = null;
          setManifestRetryTick(tick => tick + 1);
        }, 2000);
      }
    });
    return () => {
      if (manifestRequestRef.current === requestId) manifestRequestRef.current += 1;
      if (manifestImportedDeviceRef.current === importedDeviceKey) {
        manifestImportedDeviceRef.current = null;
      }
    };
  }, [targetDir, targetRevision, driveDetected, driveKey, t, manifestRetryTick]);

  useEffect(() => () => {
    if (manifestRetryTimerRef.current) clearTimeout(manifestRetryTimerRef.current);
  }, []);

  // Clear device file list and reset import flag when stick is unplugged
  useEffect(() => {
    if (!driveDetected) {
      setDeviceFilePaths([]);
      useDeviceSyncStore.getState().setPendingPlan(false);
      useDeviceSyncStore.getState().setPendingPlanDeviceId(null);
      useDeviceSyncStore.getState().setPendingPlanChecked(false);
      manifestImportedDeviceRef.current = null;
    }
  }, [driveDetected, setDeviceFilePaths]);

  return { scanDevice };
}
