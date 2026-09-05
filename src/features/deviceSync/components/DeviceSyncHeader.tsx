import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, FolderOpen, HardDriveUpload, RefreshCw, Usb,
} from 'lucide-react';
import CustomSelect from '@/ui/CustomSelect';
import type { RemovableDrive } from '@/features/deviceSync/utils/deviceSyncHelpers';
import { formatBytes } from '@/features/deviceSync/utils/deviceSyncHelpers';
import type {
  DeviceSyncLayoutMode,
  DeviceSyncPlaylistPathMode,
  DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';

interface Props {
  targetDir: string | null;
  setTargetDir: (dir: string) => void;
  sources: DeviceSyncSource[];
  drives: RemovableDrive[];
  drivesLoading: boolean;
  activeDrive: RemovableDrive | null;
  refreshDrives: () => Promise<void>;
  scanDevice: () => Promise<void>;
  handleChooseFolder: () => Promise<void>;
  startMigrationPreview: () => Promise<void>;
  layoutMode: DeviceSyncLayoutMode;
  playlistPathMode: DeviceSyncPlaylistPathMode;
  setLayoutMode: (mode: DeviceSyncLayoutMode) => void;
  setPlaylistPathMode: (mode: DeviceSyncPlaylistPathMode) => void;
  isRunning: boolean;
}

export default function DeviceSyncHeader({
  targetDir, setTargetDir, sources, drives, drivesLoading, activeDrive,
  refreshDrives, scanDevice, handleChooseFolder, startMigrationPreview,
  layoutMode, playlistPathMode, setLayoutMode, setPlaylistPathMode, isRunning,
}: Props) {
  const { t } = useTranslation();

  return (
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
            {layoutMode === 'shared-album-tree'
              ? t('deviceSync.sharedLayoutHint')
              : t('deviceSync.selfContainedLayoutHint')}
          </span>
          <div className="device-sync-playlist-options">
            <label>
              <span className="device-sync-label-inline">{t('deviceSync.playlistStorage')}</span>
              <CustomSelect
                className="input device-sync-layout-select"
                value={layoutMode}
                onChange={value => setLayoutMode(value as DeviceSyncLayoutMode)}
                disabled={isRunning}
                ariaLabel={t('deviceSync.playlistStorage')}
                options={[
                  { value: 'self-contained', label: t('deviceSync.playlistStorageSelfContained') },
                  { value: 'shared-album-tree', label: t('deviceSync.playlistStorageShared') },
                ]}
              />
            </label>
            {layoutMode === 'shared-album-tree' && (
              <label>
                <span className="device-sync-label-inline">{t('deviceSync.playlistPathStyle')}</span>
                <CustomSelect
                  className="input device-sync-layout-select"
                  value={playlistPathMode}
                  onChange={value => setPlaylistPathMode(value as DeviceSyncPlaylistPathMode)}
                  disabled={isRunning}
                  ariaLabel={t('deviceSync.playlistPathStyle')}
                  options={[
                    { value: 'playlist-relative', label: t('deviceSync.playlistPathRelative') },
                    { value: 'device-rooted', label: t('deviceSync.playlistPathRooted') },
                  ]}
                />
              </label>
            )}
          </div>
          {targetDir && sources.length > 0 && (
            <button
              className="btn btn-ghost device-sync-migrate-btn"
              onClick={startMigrationPreview}
              disabled={isRunning}
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
                <button className="btn btn-ghost" onClick={handleChooseFolder} disabled={isRunning} data-tooltip={t('deviceSync.browseManual')}>
                  <FolderOpen size={18} />
                </button>
                <button
                  className="btn btn-ghost device-sync-refresh-btn"
                  onClick={refreshDrives}
                  disabled={drivesLoading || isRunning}
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
                      disabled={isRunning}
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
  );
}
