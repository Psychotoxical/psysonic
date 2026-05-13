import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  HardDriveUpload, Loader2,
  ListMusic, Disc3, Users, CheckCircle2, AlertCircle, Clock,
  ChevronRight, ChevronDown, Trash2, Undo2, Search, Shuffle, Zap, X,
} from 'lucide-react';
import CustomSelect from '../components/CustomSelect';
import { useTranslation } from 'react-i18next';
import { useDeviceSyncStore, DeviceSyncSource } from '../store/deviceSyncStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { showToast } from '../utils/toast';
import { IS_WINDOWS } from '../utils/platform';

import {
  formatBytes,
  type SourceTab,
} from '../utils/deviceSyncHelpers';
import BrowserRow from '../components/deviceSync/BrowserRow';
import { useDeviceSyncDrives } from '../hooks/useDeviceSyncDrives';
import { useDeviceSyncSourceStatuses } from '../hooks/useDeviceSyncSourceStatuses';
import { useDeviceSyncBrowser } from '../hooks/useDeviceSyncBrowser';
import { useDeviceSyncDeviceScan } from '../hooks/useDeviceSyncDeviceScan';
import { useDeviceSyncJobEvents } from '../hooks/useDeviceSyncJobEvents';
import {
  runDeviceSyncMigrationPreview,
  runDeviceSyncMigrationExecute,
  type MigrationPhase, type MigrationPair, type MigrationResult,
} from '../utils/runDeviceSyncMigration';
import {
  runDeviceSyncSummaryPrompt,
  runDeviceSyncExecute,
  type SyncDelta,
} from '../utils/runDeviceSyncExecution';
import { runDeviceSyncChooseFolder } from '../utils/runDeviceSyncChooseFolder';
import DeviceSyncHeader from '../components/deviceSync/DeviceSyncHeader';
import DeviceSyncPreSyncModal from '../components/deviceSync/DeviceSyncPreSyncModal';
import DeviceSyncMigrationModal from '../components/deviceSync/DeviceSyncMigrationModal';

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

  const q                 = search.toLowerCase();
  const filteredPlaylists = useMemo(() => playlists.filter(p => p.name.toLowerCase().includes(q)), [playlists, q]);
  const filteredArtists   = useMemo(() => artists.filter(a => a.name.toLowerCase().includes(q)), [artists, q]);

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

        {/* ── Browser (left) ── */}
        <div className="device-sync-browser">
            <div className="device-sync-tabs">
              {tabs.map(tab => (
                <button
                  key={tab.key}
                  className={`device-sync-tab${activeTab === tab.key ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.icon}{tab.label}
                </button>
              ))}
            </div>
            <div className="device-sync-search-wrap">
              <input
                className="input"
                placeholder={t('deviceSync.searchPlaceholder')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {activeTab === 'albums' && (
                <span className="device-sync-live-badge">
                  <Zap size={10} />{t('deviceSync.liveSearch')}
                </span>
              )}
            </div>
            <div className="device-sync-list">
              {(loadingBrowser || albumSearchLoading) && (
                <div className="device-sync-loading"><Loader2 size={16} className="spin" /></div>
              )}
              {activeTab === 'albums' && !search.trim() && !loadingBrowser && randomAlbums.length > 0 && (
                <div className="device-sync-section-label">
                  <Shuffle size={11} />{t('deviceSync.randomAlbumsLabel')}
                </div>
              )}
              {activeTab === 'playlists' && filteredPlaylists.map(pl => (
                <BrowserRow key={pl.id} name={pl.name} meta={`${pl.songCount} tracks`}
                  selected={sources.some(s => s.id === pl.id) && !pendingDeletion.includes(pl.id)}
                  onToggle={() => handleToggleSource({ type: 'playlist', id: pl.id, name: pl.name })} />
              ))}
              {activeTab === 'albums' && (search.trim() ? albumSearchResults : randomAlbums).map(al => (
                <BrowserRow key={al.id} name={al.name} meta={al.artist}
                  selected={sources.some(s => s.id === al.id) && !pendingDeletion.includes(al.id)}
                  onToggle={() => handleToggleSource({ type: 'album', id: al.id, name: al.name, artist: al.artist })} />
              ))}
              {activeTab === 'artists' && filteredArtists.map(ar => (
                <React.Fragment key={ar.id}>
                  <div className="device-sync-artist-row">
                    <button
                      className="device-sync-expand-btn"
                      onClick={() => toggleArtistExpand(ar.id)}
                    >
                      {loadingArtistIds.has(ar.id)
                        ? <Loader2 size={13} className="spin" />
                        : expandedArtistIds.has(ar.id)
                          ? <ChevronDown size={13} />
                          : <ChevronRight size={13} />}
                    </button>
                    <span className="device-sync-row-name">{ar.name}</span>
                    {ar.albumCount != null &&
                      <span className="device-sync-row-meta">{ar.albumCount} Albums</span>}
                  </div>
                  {expandedArtistIds.has(ar.id) && artistAlbumsMap.has(ar.id) &&
                    artistAlbumsMap.get(ar.id)!.map(al => (
                      <BrowserRow key={al.id} name={al.name} meta={al.year?.toString()}
                        selected={sources.some(s => s.id === al.id) && !pendingDeletion.includes(al.id)}
                        indent
                        onToggle={() => handleToggleSource({ type: 'album', id: al.id, name: al.name, artist: al.artist || ar.name })} />
                    ))
                  }
                </React.Fragment>
              ))}
            </div>
          </div>

        {/* ── Device Manager (right) ── */}
        <div className="device-sync-device-panel">
          <div className="device-sync-panel-header">
            <span className="device-sync-panel-title">
              {t('deviceSync.onDevice')}
              {scanning && <Loader2 size={12} className="spin" style={{ marginLeft: 6 }} />}
            </span>
            <div className="device-sync-panel-actions">
              {/* Sync button */}
              <button
                className="btn btn-surface"
                onClick={promptSyncSummary}
                disabled={actionButtonDisabled}
              >
                {isRunning
                  ? <><Loader2 size={13} className="spin" /> {jobDone + jobSkip + jobFail}/{jobTotal}</>
                  : <>
                      {deletionCount > 0 && pendingCount === 0
                        ? <Trash2 size={13} />
                        : <HardDriveUpload size={13} />}
                      {actionButtonLabel}
                    </>
                }
              </button>

              {/* Mark for deletion */}
              {checkedIds.length > 0 && !isRunning && (
                <button
                  className="btn btn-danger"
                  onClick={handleMarkCheckedForDeletion}
                >
                  <Trash2 size={13} />
                  {t('deviceSync.deleteFromDevice', { count: checkedIds.length })}
                </button>
              )}
            </div>
          </div>

          {/* Status summary badges */}
          {sources.length > 0 && driveDetected && (
            <div className="device-sync-status-summary">
              {syncedCount > 0 && (
                <span className="device-sync-badge synced">
                  <CheckCircle2 size={11} /> {syncedCount} {t('deviceSync.statusSynced')}
                </span>
              )}
              {pendingCount > 0 && (
                <span className="device-sync-badge pending">
                  <Clock size={11} /> {pendingCount} {t('deviceSync.statusPending')}
                </span>
              )}
              {deletionCount > 0 && (
                <span className="device-sync-badge deletion">
                  <Trash2 size={11} /> {deletionCount} {t('deviceSync.statusDeletion')}
                </span>
              )}
            </div>
          )}

          {sources.length === 0 || !driveDetected ? (
            <p className="device-sync-empty">{t('deviceSync.noSourcesSelected')}</p>
          ) : (
            <>
              <div className="device-sync-list-header">
                <label className="device-sync-check-label">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                </label>
                <span className="device-sync-list-col-name">{t('deviceSync.colName')}</span>
                <span className="device-sync-list-col-type">{t('deviceSync.colType')}</span>
                <span className="device-sync-list-col-status">{t('deviceSync.colStatus')}</span>
                <span className="device-sync-list-col-actions" />
              </div>
              <div className="device-sync-device-list">
                {sources.map(s => {
                  const status = sourceStatuses.get(s.id) ?? 'pending';
                  return (
                    <label
                      key={s.id}
                      className={`device-sync-device-row ${status}${checkedIds.includes(s.id) ? ' checked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checkedIds.includes(s.id)}
                        onChange={() => toggleChecked(s.id)}
                        disabled={status === 'deletion'}
                      />
                      <span className="device-sync-row-name">
                        {s.name}
                        {s.artist && <span className="device-sync-row-artist"> · {s.artist}</span>}
                      </span>
                      <span className="device-sync-source-type">{s.type}</span>
                      <span className={`device-sync-status-icon ${status}`}>
                        {status === 'synced'   && <CheckCircle2 size={13} />}
                        {status === 'pending'  && <Clock size={13} />}
                        {status === 'deletion' && <Trash2 size={13} />}
                      </span>
                      <span className="device-sync-row-actions">
                        {status === 'synced' && (
                          <button
                            className="device-sync-action-btn danger"
                            onClick={e => { e.preventDefault(); markForDeletion([s.id]); }}
                            data-tooltip={t('deviceSync.markForDeletion')}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                        {status === 'pending' && (
                          <button
                            className="device-sync-action-btn muted"
                            onClick={e => { e.preventDefault(); handleToggleSource(s); }}
                            data-tooltip={t('deviceSync.removeSource')}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                        {status === 'deletion' && (
                          <button
                            className="device-sync-action-btn undo"
                            onClick={e => { e.preventDefault(); unmarkDeletion(s.id); }}
                            data-tooltip={t('deviceSync.undoDeletion')}
                          >
                            <Undo2 size={12} />
                          </button>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {/* Background sync progress (non-blocking) */}
          {jobStatus === 'running' && (
            <div className="device-sync-bg-progress">
              <div className="device-sync-bg-progress-bar-wrap">
                <div
                  className="device-sync-bg-progress-bar"
                  style={{ width: jobTotal > 0
                    ? `${((jobDone + jobSkip + jobFail) / jobTotal) * 100}%`
                    : '0%' }}
                />
              </div>
              <span className="device-sync-bg-progress-text">
                <Loader2 size={12} className="spin" />
                {t('deviceSync.syncInProgress', { done: jobDone + jobSkip, total: jobTotal })}
                {jobFail > 0 && <span className="device-sync-stat-error"><AlertCircle size={11} /> {jobFail}</span>}
              </span>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '2px 10px' }}
                onClick={() => {
                  const jobId = useDeviceSyncJobStore.getState().jobId;
                  if (jobId) invoke('cancel_device_sync', { jobId });
                  useDeviceSyncJobStore.getState().cancel();
                }}
              >
                {t('deviceSync.cancelSync')}
              </button>
            </div>
          )}

          {jobStatus === 'cancelled' && (
            <div className="device-sync-bg-progress done">
              <span className="device-sync-bg-progress-text">
                <AlertCircle size={12} style={{ color: 'var(--text-muted)' }} />
                {t('deviceSync.syncCancelled', { done: jobDone, total: jobTotal })}
              </span>
              <button className="btn btn-ghost" onClick={() => useDeviceSyncJobStore.getState().reset()}>
                {t('deviceSync.dismiss')}
              </button>
            </div>
          )}

          {jobStatus === 'done' && (
            <div className="device-sync-bg-progress done">
              <span className="device-sync-bg-progress-text">
                <CheckCircle2 size={12} className="color-success" />
                {t('deviceSync.syncResult', { done: jobDone, skipped: jobSkip, total: jobTotal })}
              </span>
              <button className="btn btn-ghost" onClick={() => useDeviceSyncJobStore.getState().reset()}>
                {t('deviceSync.dismiss')}
              </button>
            </div>
          )}

        </div>

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
