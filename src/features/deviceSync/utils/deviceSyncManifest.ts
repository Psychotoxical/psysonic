import { invoke } from '@tauri-apps/api/core';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  navidromeCanonicalBootstrapIsActive,
  navidromeCanonicalCheckpointStatus,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { resolveStorageServerIndexKey } from '@/lib/server/serverIndexKey';

export async function writeDeviceSyncManifest(args: {
  destDir: string;
  ownerServerIndexKey: string;
  sources: readonly DeviceSyncSource[];
}): Promise<DeviceSyncSource[]> {
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
  await invoke('write_device_manifest', {
    destDir: args.destDir,
    ownerServerIndexKey,
    sources,
    canonicalIdVersion: checkpointStatus === 'ready' ? 1 : null,
  });
  return sources;
}
