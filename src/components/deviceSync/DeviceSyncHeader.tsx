import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle, FolderOpen, HardDriveUpload, RefreshCw, Usb,
} from 'lucide-react';
import CustomSelect from '../CustomSelect';
import type { RemovableDrive } from '../../utils/deviceSyncHelpers';
import { formatBytes } from '../../utils/deviceSyncHelpers';
import type { DeviceSyncSource } from '../../store/deviceSyncStore';

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
}

export default function DeviceSyncHeader({
  targetDir, setTargetDir, sources, drives, drivesLoading, activeDrive,
  refreshDrives, scanDevice, handleChooseFolder, startMigrationPreview,
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
  );
}
