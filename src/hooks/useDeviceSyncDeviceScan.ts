import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TFunction } from 'i18next';
import { useDeviceSyncStore, type DeviceSyncSource } from '../store/deviceSyncStore';
import { showToast } from '../utils/ui/toast';

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

  const scanDevice = useCallback(async () => {
    if (!targetDir || sourcesLength === 0) {
      setDeviceFilePaths([]);
      return;
    }
    setScanning(true);
    try {
      const files = await invoke<string[]>('list_device_dir_files', { dir: targetDir });
      setDeviceFilePaths(files);
    } catch {
      setDeviceFilePaths([]);
    } finally {
      setScanning(false);
    }
  }, [targetDir, sourcesLength, setDeviceFilePaths, setScanning]);

  // Scan device on mount and when targetDir changes
  useEffect(() => { scanDevice(); }, [scanDevice]);

  // Auto-import manifest when page loads and drive is already connected
  const manifestImportedRef = useRef(false);
  useEffect(() => {
    if (!targetDir || !driveDetected || manifestImportedRef.current) return;
    manifestImportedRef.current = true;
    invoke<{ version: number; sources: DeviceSyncSource[] } | null>(
      'read_device_manifest', { destDir: targetDir }
    ).then(manifest => {
      if (manifest?.sources?.length) {
        useDeviceSyncStore.getState().clearSources();
        manifest.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
        showToast(t('deviceSync.manifestImported', { count: manifest.sources.length }), 4000, 'info');
      }
    }).catch(() => {});
  }, [targetDir, driveDetected, t]);

  // Clear device file list and reset import flag when stick is unplugged
  useEffect(() => {
    if (!driveDetected) {
      setDeviceFilePaths([]);
      manifestImportedRef.current = false;
    }
  }, [driveDetected, setDeviceFilePaths]);

  return { scanDevice };
}
