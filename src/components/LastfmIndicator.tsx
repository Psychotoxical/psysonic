import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import LastfmIcon from './LastfmIcon';

export default function LastfmIndicator() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lastfmSessionKey, lastfmUsername, lastfmSessionError } = useAuthStore();

  if (!lastfmSessionKey) return null;

  const tooltip = lastfmSessionError
    ? t('connection.lastfmSessionInvalid')
    : t('connection.lastfmConnected', { user: lastfmUsername });

  return (
    <div
      className="connection-indicator"
      style={{ cursor: 'pointer' }}
      onClick={() => navigate('/settings', { state: { tab: 'integrations' } })}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
    >
      <div
        className={`connection-led connection-led--${lastfmSessionError ? 'disconnected' : 'connected'}`}
      />
      <div className="connection-meta">
        <span className="connection-type" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <LastfmIcon size={11} />
          Last.fm
        </span>
        <span className="connection-server">
          {lastfmSessionError ? t('connection.lastfmSessionInvalid').split(' —')[0] : `@${lastfmUsername}`}
        </span>
      </div>
    </div>
  );
}
