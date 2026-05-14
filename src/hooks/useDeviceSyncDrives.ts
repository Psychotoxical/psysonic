import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RemovableDrive } from '../utils/deviceSync/deviceSyncHelpers';

export interface DeviceSyncDrivesResult {
  drives: RemovableDrive[];
  drivesLoading: boolean;
  activeDrive: RemovableDrive | null;
  driveDetected: boolean;
  refreshDrives: () => Promise<void>;
}

export function useDeviceSyncDrives(targetDir: string | null): DeviceSyncDrivesResult {
  const [drives, setDrives] = useState<RemovableDrive[]>([]);
  const [drivesLoading, setDrivesLoading] = useState(false);

  const refreshDrives = useCallback(async () => {
    setDrivesLoading(true);
    try {
      const result = await invoke<RemovableDrive[]>('get_removable_drives');
      setDrives(result);
    } catch {
      setDrives([]);
    } finally {
      setDrivesLoading(false);
    }
  }, []);

  // Fetch drives on mount, then poll every 5 seconds
  useEffect(() => {
    refreshDrives();
    const interval = setInterval(refreshDrives, 5000);
    return () => clearInterval(interval);
  }, [refreshDrives]);

  // Detect if the current targetDir is on a detected removable drive
  const activeDrive = useMemo(() => {
    if (!targetDir) return null;
    return drives.find(d => targetDir.startsWith(d.mount_point)) ?? null;
  }, [targetDir, drives]);

  const driveDetected = activeDrive !== null;

  return { drives, drivesLoading, activeDrive, driveDetected, refreshDrives };
}
