import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { TFunction } from 'i18next';
import {
  deviceSyncManifestImport,
  deviceSyncLegacySourcesFromManifest,
  useDeviceSyncStore,
  type DeviceSyncManifest,
} from '@/features/deviceSync/store/deviceSyncStore';
import { showToast } from '@/lib/dom/toast';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';

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
    const manifest = await invoke<DeviceSyncManifest | null>(
      'read_device_manifest', { destDir: dir }
    );
    if (useDeviceSyncStore.getState().targetDir !== dir) return;
    const legacySources = deviceSyncLegacySourcesFromManifest(manifest);
    if (legacySources.length > 0) {
      useDeviceSyncStore.getState().quarantineLegacySources(dir, legacySources);
    }
    const manifestImport = deviceSyncManifestImport(manifest);
    if (manifestImport) {
      await writeDeviceSyncManifest({
        destDir: dir,
        ownerServerIndexKey: manifestImport.ownerServerIndexKey,
        sources: manifestImport.sources,
        layoutMode: manifestImport.layoutMode,
        playlistPathMode: manifestImport.playlistPathMode,
        ...(manifestImport.hasMaterializedPlan
          ? { files: manifestImport.files, playlists: manifestImport.playlists }
          : {}),
      });
      if (useDeviceSyncStore.getState().targetDir !== dir) return;
      const store = useDeviceSyncStore.getState();
      store.clearSources();
      store.applyManifestConfiguration(manifestImport.layoutMode, manifestImport.playlistPathMode);
      manifestImport.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
      showToast(t('deviceSync.manifestImported', { count: manifestImport.sources.length }), 4000, 'info');
    }
  } catch { /* no manifest, that's fine */ }
  // Trigger a device scan after folder change
  setTimeout(() => scanDevice(), 100);
}
