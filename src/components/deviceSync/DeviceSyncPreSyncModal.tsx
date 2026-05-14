import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { SyncDelta } from '../../utils/deviceSync/runDeviceSyncExecution';

interface Props {
  preSyncOpen: boolean;
  preSyncLoading: boolean;
  syncDelta: SyncDelta;
  onCancel: () => void;
  onProceed: () => void;
}

export default function DeviceSyncPreSyncModal({
  preSyncOpen, preSyncLoading, syncDelta, onCancel, onProceed,
}: Props) {
  const { t } = useTranslation();

  if (!preSyncOpen) return null;

  return (
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
            <button className="btn btn-ghost" onClick={onCancel}>
              {t('deviceSync.cancel')}
            </button>
            <button
              className="btn btn-primary"
              onClick={onProceed}
              disabled={syncDelta.addBytes > syncDelta.availableBytes + syncDelta.delBytes}
            >
              {t('deviceSync.proceed')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
