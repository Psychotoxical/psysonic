import { HardDrive } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import {
  useFavoritesOfflineStatus,
  type FavoritesOfflineSemaphore,
} from '@/features/favorites/hooks/useFavoritesOfflineStatus';
import {
  disableFavoritesOfflineSync,
  scheduleFavoritesOfflineSync,
} from '@/features/offline';

function semaphoreTooltipKey(semaphore: FavoritesOfflineSemaphore): string {
  switch (semaphore) {
    case 'red':
      return 'favorites.offlineSemaphoreError';
    case 'yellow':
      return 'favorites.offlineSemaphoreSyncing';
    case 'green':
      return 'favorites.offlineSemaphoreSynced';
  }
}

export default function FavoritesOfflineHeader() {
  const { t } = useTranslation();
  const setEnabled = useAuthStore(s => s.setFavoritesOfflineEnabled);
  const { enabled, semaphore, savedCount, targetCount } = useFavoritesOfflineStatus();

  const semaphoreLabel = semaphore
    ? t(semaphoreTooltipKey(semaphore), { saved: savedCount, total: targetCount })
    : undefined;

  return (
    <div className="favorites-offline-control">
      {enabled && semaphore && (
        <span
          className={`favorites-offline-led favorites-offline-led--${semaphore}`}
          role="status"
          aria-live="polite"
          aria-label={semaphoreLabel}
          data-tooltip={semaphoreLabel}
          data-tooltip-pos="bottom"
        />
      )}
      <div
        className="favorites-offline-toggle"
        data-tooltip={t('favorites.offlineTooltip')}
        data-tooltip-pos="bottom"
      >
        <HardDrive
          size={16}
          className={`favorites-offline-disk-icon${enabled ? ' favorites-offline-disk-icon--on' : ''}`}
          aria-hidden
        />
        <label className="toggle-switch" aria-label={t('favorites.offlineTooltip')}>
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
    </div>
  );
}
