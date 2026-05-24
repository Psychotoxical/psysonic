import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export default function PlayerStatsIndexRequiredNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="settings-hint settings-hint-info player-stats-partial-index-notice" role="status">
      <Info size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        {t('statistics.playerIndexRequired')}
        {' '}
        <button
          type="button"
          className="player-stats-partial-index-link"
          onClick={() => navigate('/settings', { state: { tab: 'servers' } })}
        >
          {t('statistics.playerPartialIndexSettings')}
        </button>
      </span>
    </div>
  );
}
