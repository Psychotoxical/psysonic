import { CloudDownload, CloudOff, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import { useFavoritesOfflineStatus } from '../../hooks/useFavoritesOfflineStatus';
import {
  disableFavoritesOfflineSync,
  scheduleFavoritesOfflineSync,
} from '../../utils/offline/favoritesOfflineSync';

export default function FavoritesOfflineHeader() {
  const { t } = useTranslation();
  const setEnabled = useAuthStore(s => s.setFavoritesOfflineEnabled);
  const { enabled, status, savedCount, targetCount } = useFavoritesOfflineStatus();

  const statusLabel = (() => {
    switch (status) {
      case 'disabled':
        return t('favorites.offlineStatusDisabled');
      case 'syncing':
        return t('favorites.offlineStatusSyncing');
      case 'complete':
        return t('favorites.offlineStatusComplete', { count: savedCount });
      case 'partial':
        return t('favorites.offlineStatusPartial', { saved: savedCount, total: targetCount });
      case 'error':
        return t('favorites.offlineStatusError');
      default:
        return savedCount > 0
          ? t('favorites.offlineStatusComplete', { count: savedCount })
          : t('favorites.offlineStatusIdle');
    }
  })();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.875rem 1rem',
        borderRadius: 8,
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-elevated)',
        marginBottom: '1.5rem',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          {enabled ? <CloudDownload size={16} /> : <CloudOff size={16} />}
          <span>{t('favorites.offlineTitle')}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          {t('favorites.offlineHint')}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {status === 'syncing' && <Loader2 size={12} className="spin" />}
          {statusLabel}
        </div>
      </div>
      <label className="toggle-switch" aria-label={t('favorites.offlineToggle')}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={async e => {
            const next = e.target.checked;
            if (!next) {
              await disableFavoritesOfflineSync();
            } else {
              setEnabled(true);
              scheduleFavoritesOfflineSync();
            }
          }}
        />
        <span className="toggle-track" />
      </label>
    </div>
  );
}
