import { RefreshCw, ShieldCheck, WifiOff, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SyncStateDto } from '@/lib/api/library';
import {
  libraryStatusDisplayTrackCount,
  libraryStatusIsReady,
} from '@/lib/library/libraryReady';
import type { LibraryServerConnection } from '@/lib/library/hooks/useLibraryIndexSync';

interface ServerLibraryIndexControlsProps {
  status: SyncStateDto | null;
  connection: LibraryServerConnection;
  progressLabel: string | null;
  busy: boolean;
  actionsDisabled: boolean;
  onFullSync: () => void;
  onDeltaSync: () => void;
  onVerify: () => void;
  onCancel: () => void;
}

export default function ServerLibraryIndexControls({
  status,
  connection,
  progressLabel,
  busy,
  actionsDisabled,
  onFullSync,
  onDeltaSync,
  onVerify,
  onCancel,
}: ServerLibraryIndexControlsProps) {
  const { t } = useTranslation();

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
      style={{
        marginTop: '0.75rem',
        paddingTop: '0.75rem',
        borderTop: '1px solid color-mix(in srgb, var(--text-muted) 18%, transparent)',
      }}
    >
      <div style={{ fontSize: 12, lineHeight: 1.45, marginBottom: '0.5rem' }}>
        {connection === 'offline' ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)' }}>
            <WifiOff size={12} style={{ flexShrink: 0 }} />
            {phaseLabel}
          </span>
        ) : busy ? (
          <span style={{ color: 'var(--accent)' }}>
            {t('settings.libraryIndexServerSyncing')} {phaseLabel}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>{phaseLabel}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
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
        {busy && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={onCancel}
          >
            {t('settings.libraryIndexCancel')}
          </button>
        )}
      </div>
    </div>
  );
}
