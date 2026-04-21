import React from 'react';
import { WifiOff, RefreshCw, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

interface Props {
  onRetry: () => void;
  isChecking: boolean;
  showSettingsLink?: boolean;
  serverName?: string;
}

export default function OfflineBanner({ onRetry, isChecking, showSettingsLink, serverName }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const message = showSettingsLink
    ? t('connection.offlineNoCacheBanner', { server: serverName })
    : t('connection.offlineModeBanner');
  return (
    <div className="offline-banner">
      <WifiOff size={14} />
      <span>{message}</span>
      {showSettingsLink && (
        <button
          className="offline-banner-retry"
          onClick={() => navigate('/settings', { state: { tab: 'servers' } })}
        >
          <Settings size={12} />
          {t('connection.serverSettings')}
        </button>
      )}
      <button
        className="offline-banner-retry"
        onClick={onRetry}
        disabled={isChecking}
      >
        <RefreshCw size={12} className={isChecking ? 'spin' : ''} />
        {t('connection.retry')}
      </button>
    </div>
  );
}
