/**
 * Typed facade over the generated syncfs commands (device-sync + media-tier /
 * offline-cache). Plain commands pass through (reject on error like invoke);
 * Result-wrapped ones re-throw on error so the call sites keep their existing
 * reject semantics.
 *
 * `calculate_sync_payload` / `write_device_manifest` stay on raw `invoke`
 * because their signatures still carry `serde_json::Value`.
 */
import { commands } from '@/generated/bindings';
import type {
  LegacyOfflineMigrationResult,
  DeviceSyncFinalizePayload,
  DeviceSyncFinalizeResult,
  LibraryTierDiskHit,
  RemovableDrive,
  SyncBatchResult,
  TrackSyncInfo,
} from '@/generated/bindings';

export function computeSyncPaths(args: { tracks: TrackSyncInfo[]; destDir: string }): Promise<string[]> {
  return commands.computeSyncPaths(args.tracks, args.destDir);
}

export function getRemovableDrives(): Promise<RemovableDrive[]> {
  return commands.getRemovableDrives();
}

export function cancelDeviceSync(args: { jobId: string }): Promise<void> {
  return commands.cancelDeviceSync(args.jobId);
}

export async function listDeviceDirFiles(args: { dir: string }): Promise<string[]> {
  const res = await commands.listDeviceDirFiles(args.dir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function deleteDeviceFiles(args: { destDir: string; paths: string[] }): Promise<number> {
  const res = await commands.deleteDeviceFiles(args.destDir, args.paths);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function syncBatchToDevice(args: {
  tracks: TrackSyncInfo[];
  destDir: string;
  jobId: string;
  expectedBytes: number;
  expectedDeviceId: string;
  planId: string;
  serverId: string;
}): Promise<SyncBatchResult> {
  const res = await commands.syncBatchToDevice(
    args.tracks,
    args.destDir,
    args.jobId,
    args.expectedBytes,
    args.expectedDeviceId,
    args.planId,
    args.serverId,
  );
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function finalizeDeviceSync(args: {
  destDir: string;
  payload: DeviceSyncFinalizePayload;
}): Promise<DeviceSyncFinalizeResult> {
  const res = await commands.finalizeDeviceSync(args.destDir, args.payload);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function hasPendingDeviceSyncPlan(args: { destDir: string }): Promise<boolean> {
  const res = await commands.hasPendingDeviceSyncPlan(args.destDir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function pendingDeviceSyncPlanDeviceId(args: { destDir: string }): Promise<string | null> {
  const res = await commands.pendingDeviceSyncPlanDeviceId(args.destDir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function deviceSyncDeviceId(args: { destDir: string }): Promise<string> {
  const res = await commands.deviceSyncDeviceId(args.destDir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function writePlaylistM3u8(args: {
  destDir: string;
  playlistName: string;
  playlistId: string | null;
  tracks: TrackSyncInfo[];
  references: string[] | null;
}): Promise<void> {
  const res = await commands.writePlaylistM3u8(
    args.destDir,
    args.playlistName,
    args.playlistId,
    args.tracks,
    args.references,
  );
  if (res.status === 'error') throw new Error(res.error);
}

// --- media-tier / offline-cache (same syncfs crate) ---

/** On-disk byte total under a media tier (`ephemeral` / `library` / `favorites` / …). */
export function getMediaTierSize(args: { tier: string; mediaDir: string | null }): Promise<number> {
  return commands.getMediaTierSize(args.tier, args.mediaDir);
}

export function checkDirAccessible(args: { path: string }): Promise<boolean> {
  return commands.checkDirAccessible(args.path);
}

export function cancelOfflineDownloads(args: { downloadIds: string[] }): Promise<void> {
  return commands.cancelOfflineDownloads(args.downloadIds);
}

export function clearOfflineCancel(args: { downloadId: string }): Promise<void> {
  return commands.clearOfflineCancel(args.downloadId);
}

/** Returns, per input path, whether the media file currently exists on disk. */
export function probeMediaFiles(args: { localPaths: string[] }): Promise<boolean[]> {
  return commands.probeMediaFiles(args.localPaths);
}

export async function deleteMediaFile(args: { localPath: string; mediaDir: string | null }): Promise<void> {
  const res = await commands.deleteMediaFile(args.localPath, args.mediaDir);
  if (res.status === 'error') throw new Error(res.error);
}

export async function pruneEmptyMediaTierDirs(args: { tier: string; mediaDir: string | null }): Promise<void> {
  const res = await commands.pruneEmptyMediaTierDirs(args.tier, args.mediaDir);
  if (res.status === 'error') throw new Error(res.error);
}

export async function purgeMediaTier(args: { tier: string; mediaDir: string | null }): Promise<void> {
  const res = await commands.purgeMediaTier(args.tier, args.mediaDir);
  if (res.status === 'error') throw new Error(res.error);
}

export async function discoverLibraryTierOnDisk(args: {
  serverIndexKey: string;
  libraryServerId: string;
  candidateTrackIds: string[];
  mediaDir: string | null;
}): Promise<LibraryTierDiskHit[]> {
  const res = await commands.discoverLibraryTierOnDisk(
    args.serverIndexKey,
    args.libraryServerId,
    args.candidateTrackIds,
    args.mediaDir,
  );
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function pruneOrphanLibraryTierFiles(args: {
  serverIndexKey: string;
  keepPaths: string[];
  mediaDir: string | null;
}): Promise<string[]> {
  const res = await commands.pruneOrphanLibraryTierFiles(args.serverIndexKey, args.keepPaths, args.mediaDir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function evictEphemeralCacheOrphansToFit(args: {
  keepPaths: string[];
  maxBytes: number;
  mediaDir: string | null;
}): Promise<string[]> {
  const res = await commands.evictEphemeralCacheOrphansToFit(args.keepPaths, args.maxBytes, args.mediaDir);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function migrateLegacyOfflineDisk(args: {
  mediaDir: string | null;
  customOfflineDir: string | null;
  serverIndexKeyFilter: string | null;
}): Promise<LegacyOfflineMigrationResult[]> {
  const res = await commands.migrateLegacyOfflineDisk(
    args.mediaDir,
    args.customOfflineDir,
    args.serverIndexKeyFilter,
  );
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}
