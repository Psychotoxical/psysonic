import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOfflineBrowseContext } from '@/features/offline';
import { usePlayerStatsRecordingEnabled } from '@/features/stats/hooks/usePlayerStatsRecordingEnabled';

export default function StatisticsTabBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const playerStatsEnabled = usePlayerStatsRecordingEnabled();

  const isPlayer = location.pathname === '/player-stats';
  const showServerTab = !offlineBrowseActive;

  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
      {showServerTab && (
        <button
          type="button"
          className={`btn btn-sm ${!isPlayer ? 'btn-primary' : 'btn-surface'}`}
          onClick={() => navigate('/statistics')}
        >
          {t('statistics.tabServer')}
        </button>
      )}
      {playerStatsEnabled && (
        <button
          type="button"
          className={`btn btn-sm ${isPlayer || offlineBrowseActive ? 'btn-primary' : 'btn-surface'}`}
          onClick={() => navigate('/player-stats')}
        >
          {t('statistics.tabPlayer')}
        </button>
      )}
    </div>
  );
}
