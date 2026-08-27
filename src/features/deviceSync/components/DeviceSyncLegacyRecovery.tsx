import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deviceSyncOwnerKey,
  prepareDeviceSyncLegacyRecovery,
  useDeviceSyncStore,
} from '@/features/deviceSync/store/deviceSyncStore';
import { writeDeviceSyncManifest } from '@/features/deviceSync/utils/deviceSyncManifest';
import { showToast } from '@/lib/dom/toast';
import { navidromeCanonicalCheckpointStatus } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { serverIndexKeyForProfile } from '@/lib/server/serverBaseUrl';
import { useAuthStore } from '@/store/authStore';

export default function DeviceSyncLegacyRecovery() {
  const { t } = useTranslation();
  const legacySources = useDeviceSyncStore(state => state.legacySources);
  const legacyTargetDir = useDeviceSyncStore(state => state.legacyTargetDir);
  const targetDir = useDeviceSyncStore(state => state.targetDir);
  const sources = useDeviceSyncStore(state => state.sources);
  const servers = useAuthStore(state => state.servers);
  const [selectedOwner, setSelectedOwner] = useState('');
  const [recovering, setRecovering] = useState(false);
  const serverOptions = useMemo(() => {
    const unique = new Map<string, string>();
    servers.forEach(server => {
      const serverIndexKey = serverIndexKeyForProfile(server);
      if (serverIndexKey && !unique.has(serverIndexKey)) unique.set(serverIndexKey, server.name || server.url);
    });
    return [...unique.entries()].map(([serverIndexKey, label]) => ({ serverIndexKey, label }));
  }, [servers]);
  if (legacySources.length === 0 || legacyTargetDir !== targetDir) return null;

  const selectedStatus = selectedOwner
    ? navidromeCanonicalCheckpointStatus(selectedOwner)
    : 'absent';
  const currentOwner = deviceSyncOwnerKey(sources);
  const ownerConflict = Boolean(selectedOwner && currentOwner && currentOwner !== selectedOwner);
  const migrationPending = selectedStatus === 'pending' || selectedStatus === 'invalid';
  const recoverDisabled = recovering || !selectedOwner || ownerConflict || migrationPending;

  const recover = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      const previous = useDeviceSyncStore.getState();
      const recovery = prepareDeviceSyncLegacyRecovery({
        sources: previous.sources,
        legacySources: previous.legacySources,
        serverIndexKey: selectedOwner,
      });
      if (recovery.result !== 'recovered') return;
      if (previous.legacyTargetDir && recovery.sources.length > 0) {
        try {
          await writeDeviceSyncManifest({
            destDir: previous.legacyTargetDir,
            ownerServerIndexKey: selectedOwner,
            sources: recovery.sources,
          });
        } catch {
          showToast(t('deviceSync.legacyRecoveryWriteFailed'), 5000, 'error');
          return;
        }
      }
      const current = useDeviceSyncStore.getState();
      if (current.targetDir !== previous.targetDir
        || current.sources !== previous.sources
        || current.legacySources !== previous.legacySources
        || current.legacyTargetDir !== previous.legacyTargetDir) {
        showToast(t('deviceSync.legacyRecoveryWriteFailed'), 5000, 'error');
        return;
      }
      useDeviceSyncStore.setState({ sources: recovery.sources, legacySources: [], legacyTargetDir: null });
      showToast(t('deviceSync.legacyRecoveryComplete'), 4000, 'info');
    } finally {
      setRecovering(false);
    }
  };

  const discard = () => {
    if (!window.confirm(t('deviceSync.legacyRecoveryDiscardConfirm'))) return;
    useDeviceSyncStore.getState().discardLegacySources();
  };

  return (
    <section className="device-sync-legacy-recovery" aria-labelledby="device-sync-legacy-recovery-title">
      <div>
        <h2 id="device-sync-legacy-recovery-title">{t('deviceSync.legacyRecoveryTitle')}</h2>
        <p>{t('deviceSync.legacyRecoveryDescription', { count: legacySources.length })}</p>
      </div>
      <div className="device-sync-legacy-recovery-actions">
        <label htmlFor="device-sync-legacy-owner">{t('deviceSync.legacyRecoveryServer')}</label>
        <select
          id="device-sync-legacy-owner"
          value={selectedOwner}
          disabled={recovering}
          onChange={event => setSelectedOwner(event.target.value)}
        >
          <option value="">{t('deviceSync.legacyRecoveryChooseServer')}</option>
          {serverOptions.map(option => (
            <option key={option.serverIndexKey} value={option.serverIndexKey}>{option.label}</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" disabled={recoverDisabled} onClick={() => { void recover(); }}>
          {t('deviceSync.legacyRecoveryApply')}
        </button>
        <button type="button" className="btn btn-surface" disabled={recovering} onClick={discard}>
          {t('deviceSync.legacyRecoveryDiscard')}
        </button>
      </div>
      {migrationPending && <p className="device-sync-legacy-recovery-note">{t('deviceSync.legacyRecoveryPending')}</p>}
      {ownerConflict && <p className="device-sync-legacy-recovery-note">{t('deviceSync.legacyRecoveryOwnerConflict')}</p>}
    </section>
  );
}
