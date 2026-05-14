import React from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle, CheckCircle2, Clock, HardDriveUpload, Loader2,
  Trash2, Undo2,
} from 'lucide-react';
import { useDeviceSyncJobStore } from '../../store/deviceSyncJobStore';
import type { DeviceSyncSource } from '../../store/deviceSyncStore';
import type { SyncStatus } from '../../utils/deviceSync/deviceSyncHelpers';

interface Props {
  sources: DeviceSyncSource[];
  sourceStatuses: Map<string, SyncStatus>;
  driveDetected: boolean;
  scanning: boolean;
  checkedIds: string[];
  toggleChecked: (id: string) => void;
  allChecked: boolean;
  toggleAll: () => void;
  syncedCount: number;
  pendingCount: number;
  deletionCount: number;
  isRunning: boolean;
  actionButtonLabel: string;
  actionButtonDisabled: boolean;
  promptSyncSummary: () => Promise<void>;
  handleMarkCheckedForDeletion: () => void;
  handleToggleSource: (source: DeviceSyncSource) => void;
  markForDeletion: (ids: string[]) => void;
  unmarkDeletion: (id: string) => void;
  jobStatus: string;
  jobDone: number;
  jobSkip: number;
  jobFail: number;
  jobTotal: number;
}

export default function DeviceSyncDevicePanel({
  sources, sourceStatuses, driveDetected, scanning,
  checkedIds, toggleChecked, allChecked, toggleAll,
  syncedCount, pendingCount, deletionCount,
  isRunning, actionButtonLabel, actionButtonDisabled,
  promptSyncSummary, handleMarkCheckedForDeletion, handleToggleSource,
  markForDeletion, unmarkDeletion,
  jobStatus, jobDone, jobSkip, jobFail, jobTotal,
}: Props) {
  const { t } = useTranslation();

  return (
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
  );
}
