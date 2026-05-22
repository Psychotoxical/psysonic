import { Info } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';

export default function PlayerStatsPartialIndexNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const servers = useAuthStore(s => s.servers);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const syncExcludedByServer = useLibraryIndexStore(s => s.syncExcludedByServer);

  const excludedCount = useMemo(
    () => servers.filter(s => syncExcludedByServer[s.id] === true).length,
    [servers, syncExcludedByServer],
  );

  if (!masterEnabled || excludedCount === 0 || servers.length <= 1) {
    return null;
  }

  return (
    <div className="settings-hint settings-hint-info player-stats-partial-index-notice" role="status">
      <Info size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        {t('statistics.playerPartialIndexNotice')}
        {' '}
        <button
          type="button"
          className="player-stats-partial-index-link"
          onClick={() => navigate('/settings', { state: { tab: 'library' } })}
        >
          {t('statistics.playerPartialIndexSettings')}
        </button>
      </span>
    </div>
  );
}
