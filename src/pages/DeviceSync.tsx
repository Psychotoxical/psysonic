import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useState, useCallback, useMemo } from 'react';
import {
  HardDriveUpload, Loader2,
  ListMusic, Disc3, Users, CheckCircle2, AlertCircle, Clock,
  ChevronRight, ChevronDown, Trash2, Undo2, Search, Shuffle, Zap, X,
} from 'lucide-react';
import CustomSelect from '../components/CustomSelect';
import { useTranslation } from 'react-i18next';
import { useDeviceSyncStore, DeviceSyncSource } from '../store/deviceSyncStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { showToast } from '../utils/ui/toast';
import { IS_WINDOWS } from '../utils/platform';

import {
  formatBytes,
  type SourceTab,
} from '../utils/deviceSync/deviceSyncHelpers';
import { useDeviceSyncDrives } from '../hooks/useDeviceSyncDrives';
import { useDeviceSyncSourceStatuses } from '../hooks/useDeviceSyncSourceStatuses';
import { useDeviceSyncBrowser } from '../hooks/useDeviceSyncBrowser';
import { useDeviceSyncDeviceScan } from '../hooks/useDeviceSyncDeviceScan';
import { useDeviceSyncJobEvents } from '../hooks/useDeviceSyncJobEvents';
import {
  runDeviceSyncMigrationPreview,
  runDeviceSyncMigrationExecute,
  type MigrationPhase, type MigrationPair, type MigrationResult,
} from '../utils/deviceSync/runDeviceSyncMigration';
import {
  runDeviceSyncSummaryPrompt,
  runDeviceSyncExecute,
  type SyncDelta,
} from '../utils/deviceSync/runDeviceSyncExecution';
import { runDeviceSyncChooseFolder } from '../utils/deviceSync/runDeviceSyncChooseFolder';
import DeviceSyncHeader from '../components/deviceSync/DeviceSyncHeader';
import DeviceSyncPreSyncModal from '../components/deviceSync/DeviceSyncPreSyncModal';
import DeviceSyncMigrationModal from '../components/deviceSync/DeviceSyncMigrationModal';
import DeviceSyncBrowserPanel from '../components/deviceSync/DeviceSyncBrowserPanel';
import DeviceSyncDevicePanel from '../components/deviceSync/DeviceSyncDevicePanel';

// ─── component ───────────────────────────────────────────────────────────────

export default function DeviceSync() {
  const { t } = useTranslation();

  const targetDir        = useDeviceSyncStore(s => s.targetDir);
  const sources          = useDeviceSyncStore(s => s.sources);
  const checkedIds       = useDeviceSyncStore(s => s.checkedIds);
  const pendingDeletion  = useDeviceSyncStore(s => s.pendingDeletion);
  const deviceFilePaths  = useDeviceSyncStore(s => s.deviceFilePaths);
  const scanning         = useDeviceSyncStore(s => s.scanning);
  const {
    setTargetDir, addSource, removeSource,
    clearSources, toggleChecked, setCheckedIds, markForDeletion,
    unmarkDeletion, removeSources, setDeviceFilePaths, setScanning,
  } = useDeviceSyncStore.getState();

  const jobStatus = useDeviceSyncJobStore(s => s.status);
  const jobDone   = useDeviceSyncJobStore(s => s.done);
  const jobSkip   = useDeviceSyncJobStore(s => s.skipped);
  const jobFail   = useDeviceSyncJobStore(s => s.failed);
  const jobTotal  = useDeviceSyncJobStore(s => s.total);

  const [activeTab, setActiveTab]           = useState<SourceTab>('albums');
  const [search, setSearch]                 = useState('');
  // ─── Removable drive detection ──────────────────────────────────────────
  const { drives, drivesLoading, activeDrive, driveDetected, refreshDrives } =
    useDeviceSyncDrives(targetDir);

  const [preSyncOpen, setPreSyncOpen] = useState(false);
  const [preSyncLoading, setPreSyncLoading] = useState(false);
  const [syncDelta, setSyncDelta] = useState<SyncDelta>({ addBytes: 0, addCount: 0, delBytes: 0, delCount: 0, availableBytes: 0, tracks: [] as SubsonicSong[] });

  // ─── Migration (rename existing files into the fixed scheme) ────────────
  const [migrationPhase, setMigrationPhase] = useState<MigrationPhase>('closed');
  const [migrationOldTemplate, setMigrationOldTemplate] = useState<string>('');
  const [migrationPairs, setMigrationPairs] = useState<MigrationPair[]>([]);
  const [migrationCollisions, setMigrationCollisions] = useState<MigrationPair[]>([]);
  const [migrationUnchanged, setMigrationUnchanged] = useState(0);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);

  const isRunning = jobStatus === 'running';

  // ─── Device scan + manifest auto-import ─────────────────────────────────
  const { scanDevice } = useDeviceSyncDeviceScan(targetDir, sources.length, driveDetected, t);

  // Source status (path map + derived synced/pending/deletion)
  const { sourcePathsMap, sourceStatuses } = useDeviceSyncSourceStatuses(
    targetDir, sources, pendingDeletion, deviceFilePaths,
  );

  // ─── Desired State / Diff Logic ─────────────────────────────────────────

  const handleToggleSource = useCallback((source: DeviceSyncSource) => {
    const isSelected = sources.some(s => s.id === source.id);
    const isPendingDeletion = pendingDeletion.includes(source.id);
    const isActuallySelected = isSelected && !isPendingDeletion;

    if (isActuallySelected) {
      // User initiated a DE-SELECTION. Diff check against target device
      const isSynced = sourceStatuses.get(source.id) === 'synced';
      const pathsOnDisk = sourcePathsMap.get(source.id)?.filter(p => deviceFilePaths.includes(p)).length || 0;
      
      if (pathsOnDisk > 0 || isSynced) {
        // Source currently has physical footprint. Stage for deletion.
        markForDeletion([source.id]);
      } else {
        // Zero physical footprint. Strip safely.
        removeSource(source.id);
      }
    } else {
      // User initiated a SELECTION.
      if (isPendingDeletion) {
        unmarkDeletion(source.id); // Cancel queued red/strikethrough state
      } else if (!isSelected) {
        addSource(source); // Trigger clean pending install state
      }
    }
  }, [sources, pendingDeletion, sourceStatuses, sourcePathsMap, deviceFilePaths, markForDeletion, removeSource, unmarkDeletion, addSource]);

  // ─── Listen for background sync events ──────────────────────────────────
  useDeviceSyncJobEvents(t, scanDevice);

  // Browser (playlists / albums / artists tabs + their loaders + debounced search)
  const {
    playlists, randomAlbums, albumSearchResults, albumSearchLoading,
    artists, loadingBrowser,
    expandedArtistIds, artistAlbumsMap, loadingArtistIds,
    toggleArtistExpand,
  } = useDeviceSyncBrowser(activeTab, search, () => setSearch(''));

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

  const handleChooseFolder = () => runDeviceSyncChooseFolder({ t, setTargetDir, scanDevice });

  // ─── Sync (non-blocking) ────────────────────────────────────────────────

  const promptSyncSummary = () => runDeviceSyncSummaryPrompt({
    targetDir, sources, pendingDeletion, t,
    setPreSyncLoading, setPreSyncOpen, setSyncDelta,
  });

  const handleSyncExecution = () => runDeviceSyncExecute({
    targetDir, sources, pendingDeletion, syncDelta, t,
    setPreSyncOpen, removeSources, scanDevice,
  });

  // ─── Actions ────────────────────────────────────────────────────────────

  const handleMarkCheckedForDeletion = () => {
    if (checkedIds.length === 0) return;
    markForDeletion(checkedIds);
  };

  const allChecked = sources.length > 0 && sources.every(s => checkedIds.includes(s.id));
  const toggleAll  = () => setCheckedIds(allChecked ? [] : sources.map(s => s.id));

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

  const tabs: { key: SourceTab; icon: React.ReactNode; label: string }[] = [
    { key: 'playlists', icon: <ListMusic size={14} />, label: t('deviceSync.tabPlaylists') },
    { key: 'albums',    icon: <Disc3 size={14} />,     label: t('deviceSync.tabAlbums') },
    { key: 'artists',   icon: <Users size={14} />,     label: t('deviceSync.tabArtists') },
  ];

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
      />

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
          sources={sources}
          pendingDeletion={pendingDeletion}
          handleToggleSource={handleToggleSource}
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
