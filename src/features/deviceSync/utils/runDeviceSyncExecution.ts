import type { TFunction } from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { syncBatchToDevice } from '@/lib/api/syncfs';
import { buildDownloadUrlForServer } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  deviceSyncOwnerKey,
  deviceSyncSourceKey,
  useDeviceSyncStore,
  type DeviceSyncLayoutMode,
  type DeviceSyncManifestFile,
  type DeviceSyncManifestPlaylist,
  type DeviceSyncPlaylistPathMode,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import {
  deviceSyncJobIsActive,
  useDeviceSyncJobStore,
  type DeviceSyncJobContext,
  type DeviceSyncPlannedPlaylist,
} from '@/features/deviceSync/store/deviceSyncJobStore';
import { showToast } from '@/lib/dom/toast';
import { trackToSyncInfo, uuid } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { getAuthParams, restBaseFromUrl } from '@/lib/api/subsonicClient';
import { finalizeDeviceSyncJob } from '@/features/deviceSync/utils/finalizeDeviceSyncJob';

export interface SyncDelta {
  planId: string;
  deviceId: string;
  addBytes: number;
  addCount: number;
  delBytes: number;
  delCount: number;
  reclaimableBytes: number;
  availableBytes: number;
  tracks: SubsonicSong[];
  deletePaths: string[];
  deferredDeletePaths: string[];
  playlists: DeviceSyncPlannedPlaylist[];
  manifestFiles: DeviceSyncManifestFile[];
  manifestPlaylists: DeviceSyncManifestPlaylist[];
  context: DeviceSyncJobContext | null;
}

function deviceSyncAuth(serverIndexKey: string) {
  const server = findServerByIdOrIndexKey(serverIndexKey);
  if (!server) throw new Error(`Unknown device sync server: ${serverIndexKey}`);
  return {
    baseUrl: restBaseFromUrl(connectBaseUrlForServer(server)),
    ...getAuthParams(server.username, server.password),
    serverId: server.id,
    serverIndexKey,
  };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function contextStillCurrent(context: DeviceSyncJobContext): boolean {
  if (deviceSyncJobIsActive(useDeviceSyncJobStore.getState().status)) return false;
  const live = useDeviceSyncStore.getState();
  const liveSources = live.sources
    .filter(source => !live.pendingDeletion.includes(deviceSyncSourceKey(source)))
    .map(deviceSyncSourceKey);
  return live.targetDir === context.targetDir
    && live.layoutMode === context.layoutMode
    && live.playlistPathMode === context.playlistPathMode
    && sameStrings(liveSources, context.sources.map(deviceSyncSourceKey))
    && sameStrings(live.pendingDeletion, context.deletionSourceKeys);
}

export interface RunDeviceSyncSummaryDeps {
  targetDir: string | null;
  sources: DeviceSyncSource[];
  pendingDeletion: string[];
  layoutMode: DeviceSyncLayoutMode;
  playlistPathMode: DeviceSyncPlaylistPathMode;
  t: TFunction;
  setPreSyncLoading: (v: boolean) => void;
  setPreSyncOpen: (v: boolean) => void;
  setSyncDelta: (v: SyncDelta) => void;
}

export async function runDeviceSyncSummaryPrompt(deps: RunDeviceSyncSummaryDeps): Promise<void> {
  const {
    targetDir, sources, pendingDeletion, layoutMode, playlistPathMode,
    t, setPreSyncLoading, setPreSyncOpen, setSyncDelta,
  } = deps;

  if (!targetDir)          { showToast(t('deviceSync.noTargetDir'), 3000, 'error'); return; }
  if (sources.length === 0){ showToast(t('deviceSync.noSources'),   3000, 'error'); return; }
  const currentState = useDeviceSyncStore.getState();
  if (!currentState.pendingPlanChecked) {
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    return;
  }
  if (currentState.pendingPlan
    && currentState.pendingPlanDeviceId !== currentState.targetDeviceId) {
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    return;
  }

  setPreSyncLoading(true);
  setPreSyncOpen(true);

  try {
    const serverIndexKey = deviceSyncOwnerKey(sources);
    if (!serverIndexKey) throw new Error('Device sync sources do not have one server owner');
    const sourceSnapshot = sources.map(source => ({ ...source }));
    const deletionSnapshot = [...pendingDeletion];
    const payload = await invoke<Omit<SyncDelta, 'context'>>('calculate_sync_payload', {
      sources: sourceSnapshot,
      deletionIds: deletionSnapshot,
      auth: deviceSyncAuth(serverIndexKey),
      targetDir,
      layoutMode,
      playlistPathMode,
      expectedDeviceId: currentState.targetDeviceId,
    });
    const liveState = useDeviceSyncStore.getState();
    const sourceKeys = sourceSnapshot.map(deviceSyncSourceKey);
    if (
      liveState.targetDir !== targetDir ||
      liveState.layoutMode !== layoutMode ||
      liveState.playlistPathMode !== playlistPathMode ||
      !sameStrings(liveState.sources.map(deviceSyncSourceKey), sourceKeys) ||
      !sameStrings(liveState.pendingDeletion, deletionSnapshot)
    ) {
      setPreSyncOpen(false);
      return;
    }
    useDeviceSyncStore.getState().setTargetDeviceId(payload.deviceId);

    const resultingSources = sourceSnapshot.filter(
      source => !deletionSnapshot.includes(deviceSyncSourceKey(source)),
    );
    setSyncDelta({
      ...payload,
      context: {
        targetDir,
        deviceId: payload.deviceId,
        planId: payload.planId,
        serverIndexKey,
        sources: resultingSources,
        deletionSourceKeys: deletionSnapshot,
        layoutMode,
        playlistPathMode,
        deferredDeletePaths: [...new Set([
          ...payload.deletePaths,
          ...payload.deferredDeletePaths,
        ])],
        playlists: payload.playlists,
        manifestFiles: payload.manifestFiles,
        manifestPlaylists: payload.manifestPlaylists,
      },
    });
  } catch {
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    setPreSyncOpen(false);
  } finally {
    setPreSyncLoading(false);
  }
}

export interface RunDeviceSyncExecuteDeps {
  syncDelta: SyncDelta;
  t: TFunction;
  setPreSyncOpen: (v: boolean) => void;
  scanDevice: () => Promise<void>;
}

export async function runDeviceSyncExecute(deps: RunDeviceSyncExecuteDeps): Promise<void> {
  const { syncDelta, t, setPreSyncOpen, scanDevice } = deps;
  const { context } = syncDelta;
  if (!context) return;
  const { targetDir, serverIndexKey } = context;
  if (!contextStillCurrent(context)) {
    setPreSyncOpen(false);
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    return;
  }
  const runtimeServer = findServerByIdOrIndexKey(serverIndexKey);
  if (!runtimeServer) {
    setPreSyncOpen(false);
    showToast(t('deviceSync.fetchError'), 3000, 'error');
    return;
  }

  setPreSyncOpen(false);

  const allTracks = syncDelta.tracks;
  const jobId = uuid();
  useDeviceSyncJobStore.getState().startSync(jobId, allTracks.length, context);
  useDeviceSyncStore.getState().setPendingPlan(true);
  useDeviceSyncStore.getState().setPendingPlanDeviceId(context.deviceId);
  if (allTracks.length === 0) {
    useDeviceSyncJobStore.getState().beginFinalizing();
    try {
      await finalizeDeviceSyncJob(context);
      useDeviceSyncJobStore.getState().complete(0, 0, 0);
      if (context.deletionSourceKeys.length > 0) {
        showToast(
          t('deviceSync.deleteComplete', { count: context.deletionSourceKeys.length }),
          3000, 'info',
        );
      }
    } catch {
      useDeviceSyncJobStore.getState().fail(0, 0, 1);
      showToast(t('deviceSync.fetchError'), 3000, 'error');
    }
    await scanDevice();
    return;
  }

  showToast(t('deviceSync.syncInBackground'), 3000, 'info');

  syncBatchToDevice({
    tracks: allTracks.map(track => trackToSyncInfo(
      track,
      buildDownloadUrlForServer(runtimeServer.id, track.id),
    )),
    destDir: targetDir,
    jobId,
    expectedBytes: syncDelta.addBytes,
    expectedDeviceId: context.deviceId,
    planId: context.planId,
    serverId: runtimeServer.id,
  }).catch((err: unknown) => {
    // The typed facade rejects with an Error whose message is the raw Rust error
    // string (previously invoke rejected with the bare string).
    const msg = err instanceof Error ? err.message : String(err);
    useDeviceSyncJobStore.getState().fail(0, 0, allTracks.length);
    if (msg.includes('NOT_ENOUGH_SPACE')) {
      showToast(t('deviceSync.notEnoughSpace'), 5000, 'error');
    } else if (msg === 'NOT_MOUNTED_VOLUME') {
      showToast(t('deviceSync.notMountedVolume'), 5000, 'error');
    } else {
      showToast(t('deviceSync.fetchError'), 3000, 'error');
    }
    void scanDevice();
  });
}
