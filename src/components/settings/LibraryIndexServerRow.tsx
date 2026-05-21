import { RefreshCw, ShieldCheck, WifiOff, Zap, Ban } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ServerProfile } from '../../store/authStoreTypes';
import type { SyncStateDto } from '../../api/library';
import { serverListDisplayLabel } from '../../utils/server/serverDisplayName';
import {
  libraryStatusDisplayTrackCount,
  libraryStatusIsReady,
} from '../../utils/library/libraryReady';

export type LibraryServerConnection = 'online' | 'offline' | 'unknown';

interface LibraryIndexServerRowProps {
  server: ServerProfile;
  allServers: ServerProfile[];
  isActive: boolean;
  status: SyncStateDto | null;
  connection: LibraryServerConnection;
  progressLabel: string | null;
  busy: boolean;
  actionsDisabled: boolean;
  onFullSync: () => void;
  onDeltaSync: () => void;
  onVerify: () => void;
  onExclude: () => void;
}

export default function LibraryIndexServerRow({
  server,
  allServers,
  isActive,
  status,
  connection,
  progressLabel,
  busy,
  actionsDisabled,
  onFullSync,
  onDeltaSync,
  onVerify,
  onExclude,
}: LibraryIndexServerRowProps) {
  const { t } = useTranslation();
  const name = serverListDisplayLabel(server, allServers);

  const phaseLabel = (() => {
    if (connection === 'offline') {
      return t('settings.libraryIndexServerOffline');
    }
    if (progressLabel) return progressLabel;
    if (!status) return t('settings.libraryIndexStatusIdle');
    if (libraryStatusIsReady(status)) {
      return t('settings.libraryIndexStatusReady', {
        count: libraryStatusDisplayTrackCount(status),
      });
    }
    switch (status.syncPhase) {
      case 'initial_sync':
        return t('settings.libraryIndexStatusInitial');
      case 'error':
        return t('settings.libraryIndexStatusError');
      case 'probing':
        return t('settings.libraryIndexStatusProbing');
      default:
        return t('settings.libraryIndexStatusIdle');
    }
  })();

  return (
    <div
      className="settings-card"
      style={{
        padding: '0.85rem 1rem',
        border: isActive ? '1px solid color-mix(in srgb, var(--accent) 45%, transparent)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{name}</span>
            {isActive && (
              <span style={{ fontSize: 11, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: 'var(--radius-sm)', fontWeight: 600 }}>
                {t('settings.serverActive')}
              </span>
            )}
            {connection === 'offline' && (
              <span style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
                <WifiOff size={12} />
                {t('settings.libraryIndexServerDeferred')}
              </span>
            )}
            {busy && (
              <span style={{ fontSize: 11, color: 'var(--accent)' }}>{t('settings.libraryIndexServerSyncing')}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>
            {phaseLabel}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.65rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-surface"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={actionsDisabled || connection === 'offline'}
          onClick={onFullSync}
        >
          <RefreshCw size={13} />
          {t('settings.libraryIndexFullResync')}
        </button>
        <button
          type="button"
          className="btn btn-surface"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={actionsDisabled || connection === 'offline'}
          onClick={onDeltaSync}
        >
          <Zap size={13} />
          {t('settings.libraryIndexDeltaSync')}
        </button>
        <button
          type="button"
          className="btn btn-surface"
          style={{ fontSize: 12, padding: '4px 10px' }}
          disabled={actionsDisabled || connection === 'offline'}
          onClick={onVerify}
        >
          <ShieldCheck size={13} />
          {t('settings.libraryIndexVerify')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ fontSize: 12, padding: '4px 10px', color: 'var(--text-muted)' }}
          disabled={actionsDisabled}
          onClick={onExclude}
        >
          <Ban size={13} />
          {t('settings.libraryIndexExcludeServer')}
        </button>
      </div>
    </div>
  );
}
