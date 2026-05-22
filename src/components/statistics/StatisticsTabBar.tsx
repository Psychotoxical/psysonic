import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

export default function StatisticsTabBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const servers = useAuthStore(s => s.servers);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const syncExcludedByServer = useLibraryIndexStore(s => s.syncExcludedByServer);

  const showPlayerTab =
    masterEnabled && servers.some(s => syncExcludedByServer[s.id] !== true);
  if (!showPlayerTab) return null;

  const isPlayer = location.pathname === '/player-stats';

  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
      <button
        type="button"
        className={`btn btn-sm ${!isPlayer ? 'btn-primary' : 'btn-surface'}`}
        onClick={() => navigate('/statistics')}
      >
        {t('statistics.tabServer')}
      </button>
      <button
        type="button"
        className={`btn btn-sm ${isPlayer ? 'btn-primary' : 'btn-surface'}`}
        onClick={() => navigate('/player-stats')}
      >
        {t('statistics.tabPlayer')}
      </button>
    </div>
  );
}
