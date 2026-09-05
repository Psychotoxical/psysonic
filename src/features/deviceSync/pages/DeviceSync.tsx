import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deviceSyncSourceKey,
  useDeviceSyncStore,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import {
  deviceSyncJobIsActive,
  useDeviceSyncJobStore,
} from '@/features/deviceSync/store/deviceSyncJobStore';

import {
  type SourceTab,
} from '@/features/deviceSync/utils/deviceSyncHelpers';
import { useDeviceSyncDrives } from '@/features/deviceSync/hooks/useDeviceSyncDrives';
import { useDeviceSyncSourceStatuses } from '@/features/deviceSync/hooks/useDeviceSyncSourceStatuses';
import { useDeviceSyncBrowser } from '@/features/deviceSync/hooks/useDeviceSyncBrowser';
import { useDeviceSyncDeviceScan } from '@/features/deviceSync/hooks/useDeviceSyncDeviceScan';
import {
  runDeviceSyncMigrationPreview,
  runDeviceSyncMigrationExecute,
  type MigrationPhase, type MigrationPair, type MigrationResult,
} from '@/features/deviceSync/utils/runDeviceSyncMigration';
import {
  runDeviceSyncSummaryPrompt,
  runDeviceSyncExecute,
  type SyncDelta,
} from '@/features/deviceSync/utils/runDeviceSyncExecution';
import { runDeviceSyncChooseFolder } from '@/features/deviceSync/utils/runDeviceSyncChooseFolder';
import DeviceSyncHeader from '@/features/deviceSync/components/DeviceSyncHeader';
import DeviceSyncPreSyncModal from '@/features/deviceSync/components/DeviceSyncPreSyncModal';
import DeviceSyncMigrationModal from '@/features/deviceSync/components/DeviceSyncMigrationModal';
import DeviceSyncBrowserPanel from '@/features/deviceSync/components/DeviceSyncBrowserPanel';
import DeviceSyncDevicePanel from '@/features/deviceSync/components/DeviceSyncDevicePanel';
import DeviceSyncLegacyRecovery from '@/features/deviceSync/components/DeviceSyncLegacyRecovery';

// ─── component ───────────────────────────────────────────────────────────────

export default function DeviceSync() {
  const { t } = useTranslation();

  const targetDir        = useDeviceSyncStore(s => s.targetDir);
  const layoutMode       = useDeviceSyncStore(s => s.layoutMode);
  const playlistPathMode = useDeviceSyncStore(s => s.playlistPathMode);
  const syncedLayoutMode = useDeviceSyncStore(s => s.syncedLayoutMode);
  const syncedPlaylistPathMode = useDeviceSyncStore(s => s.syncedPlaylistPathMode);
  const sources          = useDeviceSyncStore(s => s.sources);
  const checkedIds       = useDeviceSyncStore(s => s.checkedIds);
  const pendingDeletion  = useDeviceSyncStore(s => s.pendingDeletion);
  const deviceFilePaths  = useDeviceSyncStore(s => s.deviceFilePaths);
  const scanning         = useDeviceSyncStore(s => s.scanning);
  const {
    setTargetDir, setLayoutMode, setPlaylistPathMode, addSource, removeSource,
    toggleChecked, setCheckedIds, markForDeletion,
    unmarkDeletion,
  } = useDeviceSyncStore.getState();

  const jobStatus = useDeviceSyncJobStore(s => s.status);
  const jobDone   = useDeviceSyncJobStore(s => s.done);
  const jobSkip   = useDeviceSyncJobStore(s => s.skipped);
  const jobFail   = useDeviceSyncJobStore(s => s.failed);
  const jobTotal  = useDeviceSyncJobStore(s => s.total);

  const [activeTab, setActiveTab]           = useState<SourceTab>('albums');
  const [search, setSearch]                 = useState('');
  const resetSearch = useCallback(() => setSearch(''), []);
  // ─── Removable drive detection ──────────────────────────────────────────
  const { drives, drivesLoading, activeDrive, driveDetected, refreshDrives } =
    useDeviceSyncDrives(targetDir);

  const [preSyncOpen, setPreSyncOpen] = useState(false);
  const [preSyncLoading, setPreSyncLoading] = useState(false);
  const [syncDelta, setSyncDelta] = useState<SyncDelta>({
    addBytes: 0,
    addCount: 0,
    delBytes: 0,
    delCount: 0,
    reclaimableBytes: 0,
    availableBytes: 0,
    tracks: [] as SubsonicSong[],
    deletePaths: [],
    deferredDeletePaths: [],
    playlists: [],
    manifestFiles: [],
    manifestPlaylists: [],
    context: null,
  });

  // ─── Migration (rename existing files into the fixed scheme) ────────────
  const [migrationPhase, setMigrationPhase] = useState<MigrationPhase>('closed');
  const [migrationOldTemplate, setMigrationOldTemplate] = useState<string>('');
  const [migrationPairs, setMigrationPairs] = useState<MigrationPair[]>([]);
  const [migrationCollisions, setMigrationCollisions] = useState<MigrationPair[]>([]);
  const [migrationUnchanged, setMigrationUnchanged] = useState(0);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);

  const isRunning = deviceSyncJobIsActive(jobStatus);
  const configurationDirty = layoutMode !== syncedLayoutMode
    || (layoutMode === 'shared-album-tree' && playlistPathMode !== syncedPlaylistPathMode);

  // Browser (playlists / albums / artists tabs + their loaders + debounced search)
  const {
    playlists, randomAlbums, albumSearchResults, albumSearchLoading,
    artists, loadingBrowser,
    expandedArtistIds, artistAlbumsMap, loadingArtistIds,
    toggleArtistExpand,
    serverIndexKey: browserServerIndexKey,
  } = useDeviceSyncBrowser(activeTab, search, resetSearch);

  // ─── Device scan + manifest auto-import ─────────────────────────────────
  const { scanDevice } = useDeviceSyncDeviceScan(
    targetDir,
    sources.length,
    driveDetected,
    t,
  );

  // Source status (path map + derived synced/pending/deletion)
  const { sourcePathsMap, sourceStatuses } = useDeviceSyncSourceStatuses(
    targetDir, sources, pendingDeletion, deviceFilePaths, layoutMode, configurationDirty,
  );

  // ─── Desired State / Diff Logic ─────────────────────────────────────────

  const handleToggleSource = useCallback((source: DeviceSyncSource) => {
    if (deviceSyncJobIsActive(useDeviceSyncJobStore.getState().status)) return;
    const sourceKey = deviceSyncSourceKey(source);
    const isSelected = sources.some(s => deviceSyncSourceKey(s) === sourceKey);
    const isPendingDeletion = pendingDeletion.includes(sourceKey);
    const isActuallySelected = isSelected && !isPendingDeletion;

    if (isActuallySelected) {
      // User initiated a DE-SELECTION. Diff check against target device
      const isSynced = sourceStatuses.get(sourceKey) === 'synced';
      const pathsOnDisk = sourcePathsMap.get(sourceKey)?.filter(p => deviceFilePaths.includes(p)).length || 0;
      
      if (configurationDirty || pathsOnDisk > 0 || isSynced) {
        // Source currently has physical footprint. Stage for deletion.
        markForDeletion([sourceKey]);
      } else {
        // Zero physical footprint. Strip safely.
        removeSource(sourceKey);
      }
    } else {
      // User initiated a SELECTION.
      if (isPendingDeletion) {
        unmarkDeletion(sourceKey); // Cancel queued red/strikethrough state
      } else if (!isSelected) {
        addSource(source); // Trigger clean pending install state
      }
    }
  }, [sources, pendingDeletion, sourceStatuses, sourcePathsMap, deviceFilePaths, configurationDirty, markForDeletion, removeSource, unmarkDeletion, addSource]);

  // ─── Migration handlers ─────────────────────────────────────────────────

  const startMigrationPreview = () => runDeviceSyncMigrationPreview({
    targetDir, sources,
    setMigrationPhase, setMigrationResult, setMigrationOldTemplate,
    setMigrationPairs, setMigrationCollisions, setMigrationUnchanged,
  });

  const executeMigration = () => runDeviceSyncMigrationExecute({
    targetDir, sources, migrationPairs,
    setMigrationPhase, setMigrationResult, scanDevice,
  });

  const closeMigration = () => {
    setMigrationPhase('closed');
    setMigrationPairs([]);
    setMigrationCollisions([]);
    setMigrationResult(null);
    setMigrationOldTemplate('');
  };

  const handleChooseFolder = () => runDeviceSyncChooseFolder({
    t,
    setTargetDir,
    scanDevice,
  });

  // ─── Sync (non-blocking) ────────────────────────────────────────────────

  const promptSyncSummary = () => runDeviceSyncSummaryPrompt({
    targetDir, sources, pendingDeletion, layoutMode, playlistPathMode, t,
    setPreSyncLoading, setPreSyncOpen, setSyncDelta,
  });

  const handleSyncExecution = () => runDeviceSyncExecute({
    syncDelta, t,
    setPreSyncOpen, scanDevice,
  });

  // ─── Actions ────────────────────────────────────────────────────────────

  const handleMarkCheckedForDeletion = () => {
    if (checkedIds.length === 0) return;
    markForDeletion(checkedIds);
  };

  const allChecked = sources.length > 0 && sources.every(s => checkedIds.includes(deviceSyncSourceKey(s)));
  const toggleAll  = () => setCheckedIds(allChecked ? [] : sources.map(deviceSyncSourceKey));

  const pendingCount   = Array.from(sourceStatuses.values()).filter(s => s === 'pending').length;
  const syncedCount    = Array.from(sourceStatuses.values()).filter(s => s === 'synced').length;
  const deletionCount  = pendingDeletion.length;

  // ─── Dynamic action button label ────────────────────────────────────────
  const actionButtonLabel = useMemo(() => {
    if (deletionCount > 0 && pendingCount === 0) return t('deviceSync.actionDelete');
    if (pendingCount > 0 && deletionCount === 0) return t('deviceSync.actionTransfer');
    if (pendingCount > 0 && deletionCount > 0)  return t('deviceSync.actionApplyAll');
    return t('deviceSync.syncButton'); // both zero — button will be disabled
  }, [pendingCount, deletionCount, t]);

  const actionButtonDisabled =
    !targetDir ||
    sources.length === 0 ||
    isRunning ||
    (!driveDetected && !!targetDir) ||
    (pendingCount === 0 && deletionCount === 0);

  return (
    <div className="device-sync-page">

      <DeviceSyncHeader
        targetDir={targetDir}
        setTargetDir={setTargetDir}
        sources={sources}
        drives={drives}
        drivesLoading={drivesLoading}
        activeDrive={activeDrive}
        refreshDrives={refreshDrives}
        scanDevice={scanDevice}
        handleChooseFolder={handleChooseFolder}
        startMigrationPreview={startMigrationPreview}
        layoutMode={layoutMode}
        playlistPathMode={playlistPathMode}
        setLayoutMode={setLayoutMode}
        setPlaylistPathMode={setPlaylistPathMode}
        isRunning={isRunning}
      />

      <DeviceSyncLegacyRecovery />

      {/* ── Main ── */}
      <div className="device-sync-main">

        <DeviceSyncBrowserPanel
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          search={search}
          setSearch={setSearch}
          playlists={playlists}
          randomAlbums={randomAlbums}
          albumSearchResults={albumSearchResults}
          albumSearchLoading={albumSearchLoading}
          artists={artists}
          loadingBrowser={loadingBrowser}
          expandedArtistIds={expandedArtistIds}
          artistAlbumsMap={artistAlbumsMap}
          loadingArtistIds={loadingArtistIds}
          toggleArtistExpand={toggleArtistExpand}
          serverIndexKey={browserServerIndexKey}
          sources={sources}
          pendingDeletion={pendingDeletion}
          handleToggleSource={handleToggleSource}
          disabled={isRunning}
        />

        <DeviceSyncDevicePanel
          sources={sources}
          sourceStatuses={sourceStatuses}
          driveDetected={driveDetected}
          scanning={scanning}
          checkedIds={checkedIds}
          toggleChecked={toggleChecked}
          allChecked={allChecked}
          toggleAll={toggleAll}
          syncedCount={syncedCount}
          pendingCount={pendingCount}
          deletionCount={deletionCount}
          isRunning={isRunning}
          actionButtonLabel={actionButtonLabel}
          actionButtonDisabled={actionButtonDisabled}
          promptSyncSummary={promptSyncSummary}
          handleMarkCheckedForDeletion={handleMarkCheckedForDeletion}
          handleToggleSource={handleToggleSource}
          markForDeletion={markForDeletion}
          unmarkDeletion={unmarkDeletion}
          jobStatus={jobStatus}
          jobDone={jobDone}
          jobSkip={jobSkip}
          jobFail={jobFail}
          jobTotal={jobTotal}
        />

      </div>

      <DeviceSyncPreSyncModal
        preSyncOpen={preSyncOpen}
        preSyncLoading={preSyncLoading}
        syncDelta={syncDelta}
        onCancel={() => setPreSyncOpen(false)}
        onProceed={handleSyncExecution}
      />

      <DeviceSyncMigrationModal
        migrationPhase={migrationPhase}
        migrationOldTemplate={migrationOldTemplate}
        migrationPairs={migrationPairs}
        migrationCollisions={migrationCollisions}
        migrationUnchanged={migrationUnchanged}
        migrationResult={migrationResult}
        executeMigration={executeMigration}
        closeMigration={closeMigration}
      />
    </div>
  );
}
