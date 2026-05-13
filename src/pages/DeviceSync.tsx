import { getPlaylists } from '../api/subsonicPlaylists';
import { buildDownloadUrl } from '../api/subsonicStreamUrl';
import { getArtists, getArtist } from '../api/subsonicArtists';
import { getAlbumList } from '../api/subsonicLibrary';
import type { SubsonicSong, SubsonicAlbum, SubsonicPlaylist, SubsonicArtist } from '../api/subsonicTypes';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  HardDriveUpload, FolderOpen, Loader2,
  ListMusic, Disc3, Users, CheckCircle2, AlertCircle, Clock,
  ChevronRight, ChevronDown, Trash2, Undo2, Search, Usb, RefreshCw, Shuffle, Zap, X,
} from 'lucide-react';
import CustomSelect from '../components/CustomSelect';
import { useTranslation } from 'react-i18next';
import { useDeviceSyncStore, DeviceSyncSource } from '../store/deviceSyncStore';
import { useDeviceSyncJobStore } from '../store/deviceSyncJobStore';
import { search as searchSubsonic } from '../api/subsonicSearch';
import { showToast } from '../utils/toast';
import { IS_WINDOWS } from '../utils/platform';

import {
  formatBytes, trackToSyncInfo,
  type SourceTab,
} from '../utils/deviceSyncHelpers';
import { fetchTracksForSource } from '../utils/fetchTracksForSource';
import BrowserRow from '../components/deviceSync/BrowserRow';
import { useDeviceSyncDrives } from '../hooks/useDeviceSyncDrives';
import { useDeviceSyncSourceStatuses } from '../hooks/useDeviceSyncSourceStatuses';
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
  const [playlists, setPlaylists]           = useState<SubsonicPlaylist[]>([]);
  const [randomAlbums, setRandomAlbums]     = useState<SubsonicAlbum[]>([]);
  const [albumSearchResults, setAlbumSearchResults] = useState<SubsonicAlbum[]>([]);
  const [albumSearchLoading, setAlbumSearchLoading] = useState(false);
  const [artists, setArtists]               = useState<SubsonicArtist[]>([]);
  const [loadingBrowser, setLoadingBrowser] = useState(false);
  const [expandedArtistIds, setExpandedArtistIds] = useState<Set<string>>(new Set());
  const [artistAlbumsMap, setArtistAlbumsMap]     = useState<Map<string, SubsonicAlbum[]>>(new Map());
  const [loadingArtistIds, setLoadingArtistIds]   = useState<Set<string>>(new Set());

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

  // ─── Device scan on mount ───────────────────────────────────────────────

  const scanDevice = useCallback(async () => {
    if (!targetDir || sources.length === 0) {
      setDeviceFilePaths([]);
      return;
    }
    setScanning(true);
    try {
      const files = await invoke<string[]>('list_device_dir_files', { dir: targetDir });
      setDeviceFilePaths(files);
    } catch {
      setDeviceFilePaths([]);
    } finally {
      setScanning(false);
    }
  }, [targetDir, sources.length]);

  // Scan device on mount and when targetDir changes
  useEffect(() => { scanDevice(); }, [scanDevice]);

  // Auto-import manifest when page loads and drive is already connected
  const manifestImportedRef = useRef(false);
  useEffect(() => {
    if (!targetDir || !driveDetected || manifestImportedRef.current) return;
    manifestImportedRef.current = true;
    invoke<{ version: number; sources: DeviceSyncSource[] } | null>(
      'read_device_manifest', { destDir: targetDir }
    ).then(manifest => {
      if (manifest?.sources?.length) {
        useDeviceSyncStore.getState().clearSources();
        manifest.sources.forEach(s => useDeviceSyncStore.getState().addSource(s));
        showToast(t('deviceSync.manifestImported', { count: manifest.sources.length }), 4000, 'info');
      }
    }).catch(() => {});
  }, [targetDir, driveDetected, t]);

  // Clear device file list and reset import flag when stick is unplugged
  useEffect(() => {
    if (!driveDetected) {
      setDeviceFilePaths([]);
      manifestImportedRef.current = false;
    }
  }, [driveDetected]);

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

  useEffect(() => {
    const jobStore = useDeviceSyncJobStore.getState;
    const unlistenProgress = listen<{
      jobId: string; done: number; skipped: number; failed: number; total: number;
    }>('device:sync:progress', ({ payload }) => {
      const current = jobStore();
      if (current.jobId && payload.jobId === current.jobId) {
        useDeviceSyncJobStore.getState().updateProgress(
          payload.done, payload.skipped, payload.failed
        );
      }
    });

    const unlistenComplete = listen<{
      jobId: string; done: number; skipped: number; failed: number; total: number; cancelled?: boolean;
    }>('device:sync:complete', ({ payload }) => {
      const current = jobStore();
      if (current.jobId && payload.jobId === current.jobId) {
        if (payload.cancelled) {
          useDeviceSyncJobStore.getState().complete(payload.done, payload.skipped, payload.failed);
          // status is already 'cancelled' from the button click; complete() would overwrite it — restore it
          useDeviceSyncJobStore.getState().cancel();
        } else {
          useDeviceSyncJobStore.getState().complete(payload.done, payload.skipped, payload.failed);
          showToast(
            t('deviceSync.syncResult', {
              done: payload.done, skipped: payload.skipped, total: payload.total
            }),
            5000, 'info'
          );
          // Write manifest so another machine can read the synced sources from the stick
          const { targetDir: dir, sources: srcs } = useDeviceSyncStore.getState();
          if (dir) {
            invoke('write_device_manifest', { destDir: dir, sources: srcs }).catch(() => {});
            // For every playlist source, write an Extended-M3U next to the
            // playlist-folder tracks. Context carries the playlist name +
            // per-track index so the filenames match the files we just synced.
            const playlistSources = srcs.filter(s => s.type === 'playlist');
            playlistSources.forEach(async playlist => {
              try {
                const tracks = await fetchTracksForSource(playlist);
                await invoke('write_playlist_m3u8', {
                  destDir: dir,
                  playlistName: playlist.name,
                  tracks: tracks.map((tr, idx) => trackToSyncInfo(tr, '', { name: playlist.name, index: idx + 1 })),
                });
              } catch { /* m3u8 failure is non-fatal — skip silently */ }
            });
          }
        }
        // Re-scan the device after sync completes (cancelled or not)
        scanDevice();
      }
    });

    return () => {
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
    };
  }, [t, scanDevice]);

  // Load browser data when tab switches
  useEffect(() => {
    setSearch('');
    if (activeTab === 'playlists' && playlists.length === 0) loadPlaylists();
    if (activeTab === 'albums'    && randomAlbums.length === 0) loadRandomAlbums();
    if (activeTab === 'artists'   && artists.length === 0)   loadArtists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Live album search with 300ms debounce
  useEffect(() => {
    if (activeTab !== 'albums') return;
    const q = search.trim();
    if (!q) { setAlbumSearchResults([]); return; }
    setAlbumSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { albums } = await searchSubsonic(q, { albumCount: 20, artistCount: 0, songCount: 0 });
        setAlbumSearchResults(albums);
      } catch {
        setAlbumSearchResults([]);
      } finally {
        setAlbumSearchLoading(false);
      }
    }, 300);
    return () => { clearTimeout(timer); setAlbumSearchLoading(false); };
  }, [search, activeTab]);

  const loadPlaylists = useCallback(async () => {
    setLoadingBrowser(true);
    try { setPlaylists(await getPlaylists()); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);
  const loadRandomAlbums = useCallback(async () => {
    setLoadingBrowser(true);
    try { setRandomAlbums(await getAlbumList('random', 10)); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);
  const loadArtists = useCallback(async () => {
    setLoadingBrowser(true);
    try { setArtists(await getArtists()); } catch { /* ignore */ }
    finally { setLoadingBrowser(false); }
  }, []);

  const toggleArtistExpand = useCallback(async (artistId: string) => {
    setExpandedArtistIds(prev => {
      const next = new Set(prev);
      if (next.has(artistId)) { next.delete(artistId); return next; }
      next.add(artistId);
      return next;
    });
    if (!artistAlbumsMap.has(artistId)) {
      setLoadingArtistIds(prev => new Set(prev).add(artistId));
      try {
        const { albums } = await getArtist(artistId);
        setArtistAlbumsMap(prev => new Map(prev).set(artistId, albums));
      } finally {
        setLoadingArtistIds(prev => { const n = new Set(prev); n.delete(artistId); return n; });
      }
    }
  }, [artistAlbumsMap]);

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

  const handleChooseFolder = async () => {
    const sel = await openDialog({ directory: true, multiple: false, title: t('deviceSync.chooseFolder') });
    if (sel) {
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
  };

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

      {/* ── Header ── */}
      <div className="device-sync-header">
        <div className="device-sync-header-title">
          <HardDriveUpload size={20} />
          <h1>{t('deviceSync.title')}</h1>
        </div>

        <div className="device-sync-config-row">

          {/* ── Left: Fixed schema info ── */}
          <div className="device-sync-schema-section">
            <span className="device-sync-label-inline">{t('deviceSync.schemaLabel', { defaultValue: 'Naming scheme' })}</span>
            <code className="device-sync-schema-code">
              {'{AlbumArtist}/{Album}/{TrackNum} - {Title}.{ext}'}
            </code>
            <span className="device-sync-schema-hint">
              {t('deviceSync.schemaHint', {
                defaultValue: 'Fixed scheme for reliable cross-OS sync. Playlists are written as .m3u8 that reference the album tracks — no duplicates on the device.',
              })}
            </span>
            {targetDir && sources.length > 0 && (
              <button
                className="btn btn-ghost device-sync-migrate-btn"
                onClick={startMigrationPreview}
                data-tooltip={t('deviceSync.migrateTooltip', {
                  defaultValue: 'Rename existing files on the device into the new scheme (from the old filename template).',
                })}
                data-tooltip-pos="bottom"
              >
                {t('deviceSync.migrateButton', { defaultValue: 'Reorganize existing files…' })}
              </button>
            )}
          </div>

          {/* ── Right: Drive config ── */}
          <div className="device-sync-target-section">
            <span className="device-sync-label-inline">{t('deviceSync.targetDevice')}</span>
            <div className="device-sync-header-config">
              <div className="device-sync-drive-layout">
                {/* Row 1: Controls */}
                <div className="device-sync-drive-controls">
                  {/* Fallback manual folder picker & Refresh */}
                  <button className="btn btn-ghost" onClick={handleChooseFolder} data-tooltip={t('deviceSync.browseManual')}>
                    <FolderOpen size={18} />
                  </button>
                  <button
                    className="btn btn-ghost device-sync-refresh-btn"
                    onClick={refreshDrives}
                    disabled={drivesLoading}
                    data-tooltip={t('deviceSync.refreshDrives')}
                  >
                    <RefreshCw size={18} className={drivesLoading ? 'spin' : ''} />
                  </button>

                  {/* Dropdown element */}
                  {drives.length > 0 ? (
                    <>
                      <Usb size={18} className="device-sync-drive-icon" />
                      <CustomSelect
                        className="input device-sync-drive-select"
                        value={targetDir ?? ''}
                        onChange={v => {
                          setTargetDir(v);
                          if (v) {
                            setTimeout(() => scanDevice(), 100);
                          }
                        }}
                        options={[
                          { value: '', label: t('deviceSync.selectDrive') },
                          ...drives.map(d => ({ value: d.mount_point, label: d.name || d.mount_point }))
                        ]}
                      />
                    </>
                  ) : (
                    <span className="device-sync-no-drives">
                      <AlertCircle size={18} />
                      {t('deviceSync.noDrivesDetected')}
                    </span>
                  )}
                </div>

              {/* Row 2: Metadata */}
              {activeDrive && (
                <div className="device-sync-drive-meta">
                  {formatBytes(activeDrive.available_space)} {t('deviceSync.free')} / {formatBytes(activeDrive.total_space)} &bull; {activeDrive.file_system}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>



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

      {/* Pre-Sync Summary Modal */}
      {preSyncOpen && (
        <div className="modal-overlay">
          <div className="modal-content device-sync-modal">
            <h2 className="modal-title">{t('deviceSync.syncSummary')}</h2>

            {preSyncLoading ? (
              <div className="device-sync-loading-modal" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '20px' }}>
                <Loader2 size={32} className="spin" />
                <p style={{ marginTop: '10px' }}>{t('deviceSync.calculating')}</p>
              </div>
            ) : (
              <div className="device-sync-summary-stats" style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <span>{t('deviceSync.filesToAdd')}</span>
                  <span className="color-success">+{syncDelta.addCount} ({(syncDelta.addBytes / 1_048_576).toFixed(1)} MB)</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <span>{t('deviceSync.filesToDelete')}</span>
                  <span className="color-error">-{syncDelta.delCount} ({(syncDelta.delBytes / 1_048_576).toFixed(1)} MB)</span>
                </div>
                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '10px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
                  <span>{t('deviceSync.netChange')}</span>
                  <span>{((syncDelta.addBytes - syncDelta.delBytes) / 1_048_576).toFixed(1)} MB</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', color: syncDelta.addBytes > syncDelta.availableBytes + syncDelta.delBytes ? 'var(--danger)' : 'inherit', marginTop: '10px' }}>
                  <span>{t('deviceSync.availableSpace')}</span>
                  <span>{(syncDelta.availableBytes / 1_048_576).toFixed(1)} MB</span>
                </div>
                {syncDelta.addBytes > syncDelta.availableBytes + syncDelta.delBytes && (
                  <div className="sync-warning error" style={{ background: 'color-mix(in srgb, var(--danger) 15%, transparent)', padding: '10px', borderRadius: 'var(--radius-md)', marginTop: '15px', display: 'flex', gap: '10px', color: 'var(--danger)', alignItems: 'flex-start' }}>
                    <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{t('deviceSync.spaceWarning')}</span>
                  </div>
                )}
              </div>
            )}

            {!preSyncLoading && (
              <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '25px' }}>
                <button className="btn btn-ghost" onClick={() => setPreSyncOpen(false)}>
                  {t('deviceSync.cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSyncExecution}
                  disabled={syncDelta.addBytes > syncDelta.availableBytes + syncDelta.delBytes}
                >
                  {t('deviceSync.proceed')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Migration modal (rename existing files into the fixed scheme) ── */}
      {migrationPhase !== 'closed' && (
        <div className="modal-overlay" onClick={migrationPhase === 'executing' ? undefined : closeMigration}>
          <div className="modal-content device-sync-migrate-modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{t('deviceSync.migrateTitle', { defaultValue: 'Reorganize existing files' })}</h2>
            <div className="device-sync-migrate-body">
              {migrationPhase === 'loading' && (
                <div className="device-sync-migrate-loading">
                  <Loader2 size={18} className="spin" />
                  <span>{t('deviceSync.migrateLoading', { defaultValue: 'Analyzing existing files…' })}</span>
                </div>
              )}
              {migrationPhase === 'nothing' && (
                <div className="device-sync-migrate-nothing">
                  {migrationOldTemplate ? (
                    t('deviceSync.migrateNothingToDo', { defaultValue: 'All existing files already match the new scheme — nothing to do.' })
                  ) : (
                    t('deviceSync.migrateNoTemplate', { defaultValue: 'No legacy filename template found on the device. Migration only applies when the stick was synced with a Psysonic version that supported custom templates.' })
                  )}
                </div>
              )}
              {migrationPhase === 'preview' && (
                <>
                  <div className="device-sync-migrate-summary">
                    <div>
                      <strong>{migrationPairs.length}</strong>{' '}
                      {t('deviceSync.migrateFilesToRename', { defaultValue: 'files will be renamed' })}
                    </div>
                    {migrationUnchanged > 0 && (
                      <div className="muted">
                        {t('deviceSync.migrateUnchanged', {
                          defaultValue: '{{n}} files are already at the correct path',
                          n: migrationUnchanged,
                        })}
                      </div>
                    )}
                    {migrationCollisions.length > 0 && (
                      <div className="device-sync-migrate-warning">
                        <AlertCircle size={14} />
                        {t('deviceSync.migrateCollisions', {
                          defaultValue: '{{n}} files cannot be renamed automatically (multiple tracks map to the same target). They will be left untouched — the next sync re-downloads them into the correct location.',
                          n: migrationCollisions.length,
                        })}
                      </div>
                    )}
                  </div>
                  <div className="device-sync-migrate-preview-note">
                    {t('deviceSync.migratePreviewNote', {
                      defaultValue: 'Old template: {{tpl}}',
                      tpl: migrationOldTemplate,
                    })}
                  </div>
                </>
              )}
              {migrationPhase === 'executing' && (
                <div className="device-sync-migrate-loading">
                  <Loader2 size={18} className="spin" />
                  <span>{t('deviceSync.migrateExecuting', { defaultValue: 'Renaming files…' })}</span>
                </div>
              )}
              {migrationPhase === 'done' && migrationResult && (
                <div className="device-sync-migrate-result">
                  <div className="device-sync-migrate-result-line">
                    <CheckCircle2 size={14} className="positive" />
                    {t('deviceSync.migrateSuccess', {
                      defaultValue: '{{n}} files renamed successfully',
                      n: migrationResult.ok,
                    })}
                  </div>
                  {migrationResult.failed > 0 && (
                    <div className="device-sync-migrate-result-line">
                      <AlertCircle size={14} className="danger" />
                      {t('deviceSync.migrateFailed', {
                        defaultValue: '{{n}} renames failed',
                        n: migrationResult.failed,
                      })}
                    </div>
                  )}
                  {migrationResult.errors.length > 0 && (
                    <details className="device-sync-migrate-errors">
                      <summary>{t('deviceSync.migrateShowErrors', { defaultValue: 'Show errors' })}</summary>
                      <ul>
                        {migrationResult.errors.slice(0, 50).map((err, i) => (
                          <li key={i}>{err}</li>
                        ))}
                        {migrationResult.errors.length > 50 && (
                          <li>… {migrationResult.errors.length - 50} more</li>
                        )}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
            <div className="device-sync-migrate-footer">
              {migrationPhase === 'preview' && (
                <>
                  <button className="btn btn-ghost" onClick={closeMigration}>{t('common.cancel')}</button>
                  <button className="btn btn-primary" onClick={executeMigration} disabled={migrationPairs.length === 0}>
                    {t('deviceSync.migrateStart', { defaultValue: 'Start renaming' })}
                  </button>
                </>
              )}
              {(migrationPhase === 'done' || migrationPhase === 'nothing') && (
                <button className="btn btn-primary" onClick={closeMigration}>{t('common.close')}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
