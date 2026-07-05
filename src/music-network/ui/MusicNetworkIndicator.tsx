import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEnrichmentPrimary } from '@/music-network';
import { renderPresetIcon } from '@/music-network/ui/presetIcon';

/**
 * Sidebar status indicator for the enrichment primary (the account that drives
 * love/similar/stats). Mirrors the old Last.fm indicator: green when connected,
 * red on session error, click → Integrations. Hidden when no primary is set.
 */
export default function MusicNetworkIndicator() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ep = useEnrichmentPrimary();
  if (!ep) return null;
  const { account: primary, icon } = ep;

  const subtitle = primary.sessionError
    ? t('musicNetwork.statusError')
    : primary.username
      ? `@${primary.username}`
      : t('musicNetwork.statusConnected');
  const tooltip = primary.sessionError
    ? t('musicNetwork.statusError')
    : primary.username
      ? `${primary.label} · @${primary.username}`
      : primary.label;

  return (
    <div
      className="connection-indicator"
      style={{ cursor: 'pointer' }}
      onClick={() => navigate('/settings', { state: { tab: 'integrations' } })}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
    >
      <div className={`connection-led connection-led--${primary.sessionError ? 'disconnected' : 'connected'}`} />
      <div className="connection-meta">
        <span className="connection-type" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          {renderPresetIcon(icon, 11)}
          {primary.label}
        </span>
        <span className="connection-server">{subtitle}</span>
      </div>
    </div>
  );
}
