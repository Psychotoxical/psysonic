import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listDeviceDirFiles } from '@/lib/api/syncfs';
import type { TFunction } from 'i18next';
import {
  deviceSyncManifestImport,
  deviceSyncLegacySourcesFromManifest,
  useDeviceSyncStore,
  type DeviceSyncManifest,
} from '@/features/deviceSync/store/deviceSyncStore';
import { showToast } from '@/lib/dom/toast';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

export interface DeviceSyncDeviceScanResult {
  scanDevice: () => Promise<void>;
}

export function useDeviceSyncDeviceScan(
  targetDir: string | null,
  sourcesLength: number,
  driveDetected: boolean,
  t: TFunction,
): DeviceSyncDeviceScanResult {
  const setDeviceFilePaths = useDeviceSyncStore.getState().setDeviceFilePaths;
  const setScanning        = useDeviceSyncStore.getState().setScanning;
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
  const manifestImportedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetDir || !driveDetected || manifestImportedTargetRef.current === targetDir) return;
    const requestTarget = targetDir;
    manifestImportedTargetRef.current = requestTarget;
    invoke<DeviceSyncManifest | null>(
      'read_device_manifest', { destDir: targetDir }
    ).then(async manifest => {
      if (useDeviceSyncStore.getState().targetDir !== requestTarget) return;
      const legacySources = deviceSyncLegacySourcesFromManifest(manifest);
      if (legacySources.length > 0) {
        useDeviceSyncStore.getState().quarantineLegacySources(requestTarget, legacySources);
      }
      const manifestImport = deviceSyncManifestImport(manifest);
      if (manifestImport) {
        await writeDeviceSyncManifest({
          destDir: requestTarget,
          ownerServerIndexKey: manifestImport.ownerServerIndexKey,
          sources: manifestImport.sources,
        });
        if (useDeviceSyncStore.getState().targetDir !== requestTarget) return;
        useDeviceSyncStore.getState().clearSources();
        manifestImport.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
        showToast(t('deviceSync.manifestImported', { count: manifestImport.sources.length }), 4000, 'info');
      }
    }).catch(() => {
      if (useDeviceSyncStore.getState().targetDir === requestTarget) {
        manifestImportedTargetRef.current = null;
        if (manifestRetryTimerRef.current) clearTimeout(manifestRetryTimerRef.current);
        manifestRetryTimerRef.current = setTimeout(() => {
          manifestRetryTimerRef.current = null;
          setManifestRetryTick(tick => tick + 1);
        }, 2000);
      }
    });
  }, [targetDir, driveDetected, t, manifestRetryTick]);

  useEffect(() => () => {
    if (manifestRetryTimerRef.current) clearTimeout(manifestRetryTimerRef.current);
  }, []);

  // Clear device file list and reset import flag when stick is unplugged
  useEffect(() => {
    if (!driveDetected) {
      setDeviceFilePaths([]);
      manifestImportedTargetRef.current = null;
    }
  }, [driveDetected, setDeviceFilePaths]);

  return { scanDevice };
}
