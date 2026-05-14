import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { TFunction } from 'i18next';
import { useDeviceSyncStore, type DeviceSyncSource } from '../../store/deviceSyncStore';
import { showToast } from '../ui/toast';

export interface RunDeviceSyncChooseFolderDeps {
  t: TFunction;
  setTargetDir: (dir: string) => void;
  scanDevice: () => Promise<void>;
}

export async function runDeviceSyncChooseFolder(deps: RunDeviceSyncChooseFolderDeps): Promise<void> {
  const { t, setTargetDir, scanDevice } = deps;
  const sel = await openDialog({ directory: true, multiple: false, title: t('deviceSync.chooseFolder') });
  if (!sel) return;

  const dir = sel as string;
  setTargetDir(dir);
  // If the device has a psysonic-sync.json, always import it — replacing any
  // sources from a previous device so switching sticks works correctly.
  try {
    const manifest = await invoke<{ version: number; sources: DeviceSyncSource[] } | null>(
      'read_device_manifest', { destDir: dir }
    );
    if (manifest?.sources?.length) {
      useDeviceSyncStore.getState().clearSources();
      manifest.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
      showToast(t('deviceSync.manifestImported', { count: manifest.sources.length }), 4000, 'info');
    }
  } catch { /* no manifest, that's fine */ }
  // Trigger a device scan after folder change
  setTimeout(() => scanDevice(), 100);
}
