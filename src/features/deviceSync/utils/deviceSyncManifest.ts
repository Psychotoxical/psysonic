import { invoke } from '@tauri-apps/api/core';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  type DeviceSyncLayoutMode,
  type DeviceSyncManifestFile,
  type DeviceSyncManifestPlaylist,
  type DeviceSyncPlaylistPathMode,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  navidromeCanonicalBootstrapIsActive,
  navidromeCanonicalCheckpointStatus,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { resolveStorageServerIndexKey } from '@/lib/server/serverIndexKey';

interface DeviceSyncManifestInput {
  destDir: string;
  ownerServerIndexKey: string;
  sources: readonly DeviceSyncSource[];
  layoutMode?: DeviceSyncLayoutMode;
  playlistPathMode?: DeviceSyncPlaylistPathMode;
  files?: readonly DeviceSyncManifestFile[];
  playlists?: readonly DeviceSyncManifestPlaylist[];
}

export function prepareDeviceSyncManifest(args: DeviceSyncManifestInput): {
  ownerServerIndexKey: string;
  sources: DeviceSyncSource[];
  canonicalIdVersion: number | null;
} {
  if (navidromeCanonicalBootstrapIsActive()) throw new Error('canonical_migration_active');
  const ownerServerIndexKey = resolveStorageServerIndexKey(args.ownerServerIndexKey);
  const sourceOwner = deviceSyncOwnerKey(args.sources);
  if (!ownerServerIndexKey || (args.sources.length > 0 && sourceOwner !== ownerServerIndexKey)) {
    throw new Error('DEVICE_SYNC_SERVER_OWNER_MISMATCH');
  }
  const checkpointStatus = navidromeCanonicalCheckpointStatus(ownerServerIndexKey);
  if (checkpointStatus === 'pending' || checkpointStatus === 'invalid') {
    throw new Error(`canonical_migration_not_ready:${ownerServerIndexKey}`);
  }
  const normalized = new Map<string, DeviceSyncSource>();
  for (const source of args.sources) {
    const next = checkpointStatus === 'ready'
      ? { ...source, id: canonicalNavidromeId(source.id), serverIndexKey: ownerServerIndexKey }
      : { ...source, serverIndexKey: ownerServerIndexKey };
    normalized.set(deviceSyncSourceKey(next), next);
  }
  const sources = [...normalized.values()];
  return {
    ownerServerIndexKey,
    sources,
    canonicalIdVersion: checkpointStatus === 'ready' ? 1 : null,
  };
}

export async function writeDeviceSyncManifest(args: DeviceSyncManifestInput): Promise<DeviceSyncSource[]> {
  const prepared = prepareDeviceSyncManifest(args);
  await invoke('write_device_manifest', {
    destDir: args.destDir,
    ownerServerIndexKey: prepared.ownerServerIndexKey,
    sources: prepared.sources,
    canonicalIdVersion: prepared.canonicalIdVersion,
    layoutMode: args.layoutMode,
    playlistPathMode: args.playlistPathMode,
    files: args.files,
    playlists: args.playlists,
  });
  return prepared.sources;
}
