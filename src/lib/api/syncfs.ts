/**
 * Typed facade over the generated syncfs commands (device-sync + media-tier /
 * offline-cache). Plain commands pass through (reject on error like invoke);
 * Result-wrapped ones re-throw on error so the call sites keep their existing
 * reject semantics.
 *
 * `calculate_sync_payload` / `write_device_manifest` / `write_playlist_m3u8`
 * stay on raw `invoke` (untypeable — `serde_json::Value` in their signatures).
 */
import { commands } from '@/generated/bindings';
import type {
  LegacyOfflineMigrationResult,
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

export async function deleteDeviceFiles(args: { paths: string[] }): Promise<number> {
  const res = await commands.deleteDeviceFiles(args.paths);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function syncBatchToDevice(args: {
  tracks: TrackSyncInfo[];
  destDir: string;
  jobId: string;
  expectedBytes: number;
}): Promise<SyncBatchResult> {
  const res = await commands.syncBatchToDevice(args.tracks, args.destDir, args.jobId, args.expectedBytes);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
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
