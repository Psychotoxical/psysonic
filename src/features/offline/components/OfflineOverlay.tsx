import { useTranslation } from 'react-i18next';
import { WifiOff, RefreshCw } from 'lucide-react';

interface Props {
  serverName: string;
  onRetry: () => void;
  isChecking: boolean;
}

export default function OfflineOverlay({ serverName, onRetry, isChecking }: Props) {
  const { t } = useTranslation();

  return (
    <div className="offline-overlay">
      <div className="offline-overlay-card">
        <WifiOff size={48} className="offline-icon" />
        <h2 className="offline-title">{t('connection.offlineTitle')}</h2>
        <p className="offline-subtitle">
          {t('connection.offlineSubtitle', { server: serverName })}
        </p>
        <button
          className="btn btn-primary offline-retry"
          onClick={onRetry}
          disabled={isChecking}
        >
          <RefreshCw size={16} className={isChecking ? 'spin' : ''} />
          {isChecking ? t('connection.checking') : t('connection.retry')}
        </button>
      </div>
    </div>
  );
}
